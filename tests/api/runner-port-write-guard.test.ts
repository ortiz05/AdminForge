import { createRunnerPort } from '@adminforge/api/src/runs/ports';
import { protectedObjectRefused } from '@adminforge/api/src/execution/protected';
import { writesPausedError } from '@adminforge/api/src/execution/emergency';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import type { TokenBroker } from '@adminforge/api/src/auth/token-broker';
import { StepError, type ResolvedIdentity, type RunnerJob } from '@adminforge/engine';
import { newKey } from '../unit/runner/helpers';

// PowerShell write jobs pass the same emergency stop and protected-object guard as REST writes (runs/ports.ts), before
// any token is minted or the runner is called; read jobs don't.
const TENANT = { id: '11111111-2222-4333-8444-555555555555', domain: 'example.com' };
const PROTECTED = '99999999-9999-4999-8999-999999999999';

const identity = {
  actor: { kind: 'delegated', oid: 'u', upn: 'u@example.com' },
  mode: 'write',
  handle: { kind: 'delegated', session: { idHash: 'h', userOid: 'u', upn: 'u@example.com' }, mode: 'write' },
} as unknown as ResolvedIdentity;

const job = (mode: 'read' | 'write', parameters: Record<string, unknown>): RunnerJob => ({
  jobId: `run-1:step-${Math.random().toString(36).slice(2)}`,
  script: 'exchange/Set-Test.ps1',
  sha256: 'a'.repeat(64),
  parameters,
  services: ['exchange'],
  timeoutSeconds: 60,
  mode,
});

function setup(guard: (targets: unknown[]) => Promise<void>) {
  const seen: unknown[][] = [];
  const brokerCalls: string[] = [];
  const outbound = {
    execute: async () => {
      throw new Error('not used');
    },
    assertWritable: async (_who: unknown, targets: unknown[]) => {
      seen.push(targets);
      await guard(targets);
    },
  } as unknown as OutboundExecutor;
  const broker = {
    get: async (_s: unknown, service: string) => {
      brokerCalls.push(service);
      throw new Error('stop here: the guard already passed');
    },
  } as unknown as TokenBroker;
  const port = createRunnerPort({
    url: 'http://127.0.0.1:3101',
    key: newKey(),
    broker,
    tenant: TENANT,
    outbound,
    fetch: async () => {
      throw new Error('the runner must not be called');
    },
  });
  const run = (j: RunnerJob) =>
    port.run(identity, j, { signal: new AbortController().signal, onEvent: () => undefined }).then(
      () => undefined,
      (e: unknown) => e,
    );
  return { run, seen, brokerCalls };
}

describe('runner port: write guard', () => {
  it('refuses a write job while changes are paused, before minting tokens', async () => {
    const t = setup(async () => {
      throw writesPausedError();
    });
    const err = await t.run(job('write', { identity: 'someone@example.com' }));
    expect(err).toBeInstanceOf(StepError);
    expect(err).toMatchObject({ code: 'writes_paused' });
    expect(t.brokerCalls).toEqual([]);
  });

  it('refuses a write job whose inputs name a protected object', async () => {
    const t = setup(async (targets) => {
      if (JSON.stringify(targets).includes(PROTECTED)) throw protectedObjectRefused();
    });
    const err = await t.run(job('write', { objectId: PROTECTED }));
    expect(err).toMatchObject({ code: 'protected_object' });
    expect(t.seen[0]).toEqual([
      { service: 'exchange', method: 'POST', path: 'exchange/Set-Test.ps1', body: { objectId: PROTECTED } },
    ]);
    expect(t.brokerCalls).toEqual([]);
  });

  it('lets other writes through to the token step, and never checks read jobs', async () => {
    const t = setup(async () => undefined);
    await t.run(job('write', { identity: 'someone@example.com' }));
    expect(t.brokerCalls).toEqual(['exchange']);
    await t.run(job('read', { objectId: PROTECTED }));
    expect(t.seen).toHaveLength(1);
  });
});
