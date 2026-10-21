import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContext } from '@adminforge/api/src/context';
import { AppError } from '@adminforge/api/src/errors';
import type { ExecutionIdentity, OutboundExecutor } from '@adminforge/api/src/execution/types';
import { createFixtureRunnerPort } from '@adminforge/api/src/runs/fixture-runner';
import { createRunsModule } from '@adminforge/api/src/runs/module';
import { StepError, type ResolvedIdentity, type RunnerJob, type RunnerStreamEvent } from '@adminforge/engine';
import { entraConfig } from './helpers';

// M2 (whole-branch security review): with DATA_MODE=fixtures a playbook's PowerShell steps answer from the runner
// fixtures — as `source: runner` datasources already did — and never reach the real runner. Before, Entra sign-in on
// fixtures with RUNNER_URL and RUNNER_SHARED_KEY set sent them to the runner with real Exchange tokens while every REST
// step, and the protected-object guard, read fixtures.

const SESSION = { idHash: 'h', userOid: 'u', upn: 'avery@example.com' };
const delegated = {
  actor: { kind: 'delegated', oid: 'u', upn: 'avery@example.com' },
  mode: 'write',
  handle: { kind: 'delegated', session: SESSION, mode: 'write' },
} as unknown as ResolvedIdentity;
const automation = {
  actor: { kind: 'automation', oid: null, upn: null },
  mode: 'write',
  handle: { kind: 'automation', mode: 'write' },
} as unknown as ResolvedIdentity;

const job = (patch: Partial<RunnerJob> = {}): RunnerJob => ({
  jobId: 'run-1:step',
  script: 'exchange/Get-Thing.ps1',
  sha256: 'a'.repeat(64),
  parameters: { identity: 'avery@example.com' },
  services: ['exchange'],
  mode: 'read',
  ...patch,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-fixture-runner-'));
  const put = (rel: string, body: unknown) => {
    mkdirSync(path.dirname(path.join(dir, 'runner', rel)), { recursive: true });
    writeFileSync(path.join(dir, 'runner', rel), JSON.stringify(body));
  };
  put('exchange/Get-Thing.ps1.json', [{ name: 'Avery', forwarding: null }]);
  put('exchange/Get-Many.ps1.json', [{ n: 1 }, { n: 2 }]);
  put('exchange/Get-Variant.ps1.json', {
    $fixture: {
      variants: [{ match: { bodyIncludes: '"identity":"blake@example.com"' }, body: [{ who: 'Blake' }] }],
      body: [{ who: 'anyone' }],
    },
  });
  put('exchange/Set-Thing.ps1.json', [{ changed: true }]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(port: ReturnType<typeof createFixtureRunnerPort>, j: RunnerJob, identity = delegated) {
  const events: RunnerStreamEvent[] = [];
  const result = await port.run(identity, j, {
    signal: new AbortController().signal,
    onEvent: (e) => {
      events.push(e);
    },
  });
  return { result, events };
}

const failure = async (p: Promise<unknown>): Promise<StepError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StepError);
  return err as StepError;
};

/** An outbound whose write guard records what it was asked and refuses when told to. */
function guard(refuse?: AppError) {
  const asked: Array<{ identity: ExecutionIdentity; targets: unknown[] }> = [];
  const outbound = {
    execute: async () => {
      throw new Error('no REST call expected');
    },
    assertWritable: async (identity: ExecutionIdentity, targets: unknown[]) => {
      asked.push({ identity, targets });
      if (refuse) throw refuse;
    },
  } as unknown as OutboundExecutor;
  return { outbound, asked };
}

describe('the fixture runner port', () => {
  it('answers a script from its fixture: one output as the output, several as an array, each as an event', async () => {
    const port = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: false });
    const one = await run(port, job());
    expect(one.result).toEqual({ status: 'succeeded', output: { name: 'Avery', forwarding: null } });
    expect(one.events).toEqual([{ type: 'output', data: { name: 'Avery', forwarding: null } }]);
    const many = await run(port, job({ script: 'exchange/Get-Many.ps1' }));
    expect(many.result.output).toEqual([{ n: 1 }, { n: 2 }]);
    expect(many.events).toHaveLength(2);
  });

  it('matches $fixture variants on the parameters, like PowerShell datasources', async () => {
    const port = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: false });
    const blake = await run(
      port,
      job({ script: 'exchange/Get-Variant.ps1', parameters: { identity: 'blake@example.com' } }),
    );
    expect(blake.result.output).toEqual({ who: 'Blake' });
    expect((await run(port, job({ script: 'exchange/Get-Variant.ps1' }))).result.output).toEqual({
      who: 'anyone',
    });
  });

  it('passes a write script through the emergency stop and the protected-object guard first', async () => {
    const ok = guard();
    const port = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: false, outbound: ok.outbound });
    const write = job({ script: 'exchange/Set-Thing.ps1', mode: 'write', parameters: { identity: 'u-1' } });
    expect((await run(port, write)).result.output).toEqual({ changed: true });
    expect(ok.asked).toEqual([
      {
        identity: { kind: 'delegated', session: SESSION, mode: 'write' },
        targets: [
          { service: 'exchange', method: 'POST', path: 'exchange/Set-Thing.ps1', body: { identity: 'u-1' } },
        ],
      },
    ]);
    // Reads aren't asked about.
    await run(port, job());
    expect(ok.asked).toHaveLength(1);

    const paused = guard(new AppError(503, 'writes_paused', 'An administrator has paused all changes.'));
    const refused = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: true, outbound: paused.outbound });
    expect(await failure(run(refused, write))).toMatchObject({ code: 'writes_paused' });
  });

  it('with mock sign-in accepts a write no fixture describes (no tenant); with Entra sign-in it fails', async () => {
    const write = job({ script: 'exchange/Set-Unknown.ps1', mode: 'write' });
    const mock = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: true });
    expect(await run(mock, write)).toEqual({ result: { status: 'succeeded', output: null }, events: [] });
    const entra = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: false });
    expect(await failure(run(entra, write))).toMatchObject({ code: 'upstream_not_found' });
  });

  it('never accepts a read no fixture describes', async () => {
    const mock = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: true });
    expect(await failure(run(mock, job({ script: 'exchange/Get-Unknown.ps1' })))).toMatchObject({
      code: 'upstream_not_found',
    });
  });

  it('refuses scheduled (automation) runs, as the runner does', async () => {
    const port = createFixtureRunnerPort({ dir, acceptUnfixturedWrites: true });
    expect(await failure(run(port, job(), automation))).toMatchObject({ code: 'runner_unsupported' });
  });
});

describe('the runs module with DATA_MODE=fixtures', () => {
  const RUNNER_URL = 'http://127.0.0.1:3101';
  const RUNNER_SHARED_KEY = Buffer.alloc(32, 9).toString('base64');

  function module(overrides: Record<string, string>) {
    const calls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      throw new Error('the network is off in this test');
    }) as typeof globalThis.fetch;
    const config = entraConfig({ RUNNER_URL, RUNNER_SHARED_KEY, CONTENT_WATCH: 'false', ...overrides });
    const ctx = createContext(config, { database: null, fetch });
    const runs = createRunsModule(ctx, { inProcessWorker: false, sweep: false });
    return { ctx, runs, calls };
  }

  beforeEach(() => vi.stubEnv('ADMINFORGE_ENV_FILE', '/dev/null'));
  afterEach(() => vi.unstubAllEnvs());

  it('Entra sign-in with a runner configured: PowerShell steps read the fixtures, nothing reaches the runner', async () => {
    // Outside tests (NODE_ENV=development), where the real runner port would be built from RUNNER_URL.
    const { ctx, runs, calls } = module({
      NODE_ENV: 'development',
      DATA_MODE: 'fixtures',
      ADMINFORGE_FIXTURES_DIR: dir,
    });
    try {
      const port = runs.engine.opts.runner!;
      expect(port).toBeDefined();
      const { result } = await run(port as ReturnType<typeof createFixtureRunnerPort>, job());
      expect(result.output).toEqual({ name: 'Avery', forwarding: null });
      // An unfixtured write fails (a real person is signed in): nothing is accepted that no fixture describes.
      expect(
        await failure(
          run(port as never, job({ script: 'exchange/Set-Unknown.ps1', mode: 'write', parameters: {} })),
        ),
      ).toMatchObject({ code: 'upstream_not_found' });
      expect(calls).toEqual([]);
    } finally {
      await runs.stop();
      await ctx.definitions.close();
    }
  });

  it('live data keeps the runner configuration (no runner port in tests, as before)', async () => {
    const { ctx, runs } = module({ DATA_MODE: 'live' });
    try {
      expect(runs.engine.opts.runner).toBeUndefined();
    } finally {
      await runs.stop();
      await ctx.definitions.close();
    }
  });
});
