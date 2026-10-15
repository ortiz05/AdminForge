import path from 'node:path';
import {
  bulkDefinition,
  BULK_CHILD_ID,
  BULK_LOOP_ID,
  runPlaybookTest,
  runPlaybookTests,
  type ChildRunner,
} from '@adminforge/engine';
import { loadContentDir, type Playbook as PlaybookDef } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';
import { harness, playbook, read, write } from './helpers';

const def = playbook(
  [
    read('lookup', `/users/\${ $encode(inputs.userId) }`),
    {
      id: 'guard',
      type: 'assert',
      that: '${ steps.lookup.output.accountEnabled = true }',
      message: 'already disabled',
    },
    write('disable', {
      compensate: {
        type: 'graph',
        request: { method: 'PATCH', path: '/users/${ inputs.userId }', body: { accountEnabled: true } },
      },
    }),
    write('revoke', { onError: 'compensate', dryRunOutput: { value: true } }),
  ],
  {
    inputs: { userId: { type: 'string', format: 'guid' } },
    outputs: { revoked: '${ steps.revoke.output.value }' },
    tests: [
      {
        name: 'guard',
        inputs: { userId: '00000000-0000-4000-8000-000000000001' },
        mocks: { lookup: { accountEnabled: false } },
        expect: { status: 'failed', failedStep: 'guard' },
      },
      {
        name: 'plan',
        inputs: { userId: '00000000-0000-4000-8000-000000000001' },
        mocks: { lookup: { accountEnabled: true } },
        expect: {
          status: 'succeeded',
          plan: ['disable', 'revoke'],
          outputs: { revoked: true },
          steps: { lookup: 'succeeded', disable: 'planned' },
        },
      },
      {
        name: 'compensates',
        inputs: { userId: '00000000-0000-4000-8000-000000000001' },
        mocks: { lookup: { accountEnabled: true } },
        errors: { revoke: { status: 400, code: 'BadRequest' } },
        expect: {
          status: 'compensated',
          plan: ['disable', 'revoke'],
          steps: { disable: 'compensated', revoke: 'failed' },
        },
      },
    ],
  },
);

describe('runPlaybookTests', () => {
  it('runs every tests: block in a sandbox and checks expect', async () => {
    const results = await runPlaybookTests(def);
    expect(results.map((r) => [r.name, r.passed, r.failures])).toEqual([
      ['guard', true, []],
      ['plan', true, []],
      ['compensates', true, []],
    ]);
    expect(results[2]!.plan.map((p) => [p.stepId, p.compensation ?? false])).toEqual([
      ['disable', false],
      ['revoke', false],
      ['disable', true],
    ]);
  });

  it('explains every mismatch', async () => {
    const r = await runPlaybookTest(def, {
      name: 'wrong',
      inputs: { userId: '00000000-0000-4000-8000-000000000001' },
      mocks: { lookup: { accountEnabled: true } },
      expect: {
        status: 'failed',
        failedStep: 'guard',
        plan: ['revoke'],
        outputs: { revoked: false },
        steps: { guard: 'failed', revoke: 'succeeded' },
      },
    });
    expect(r.passed).toBe(false);
    expect(r.failures).toEqual([
      'status: expected failed, got succeeded',
      'failedStep: expected guard, got none',
      'plan: expected [revoke], got [disable, revoke]',
      'outputs.revoked: expected false, got true',
      'steps.guard: expected failed, got succeeded',
      'steps.revoke: expected succeeded, got planned',
    ]);
  });

  it('fails reads without mocks (tests never call services) and reports invalid inputs', async () => {
    const noMock = await runPlaybookTest(def, {
      name: 'x',
      inputs: { userId: '00000000-0000-4000-8000-000000000001' },
      expect: { status: 'succeeded' },
    });
    expect(noMock.failures[0]).toMatch(
      /status: expected succeeded, got failed \(lookup: no_mock — No mock for graph GET \/users\/00000000-0000-4000-8000-000000000001/,
    );
    const bad = await runPlaybookTest(def, {
      name: 'y',
      inputs: { userId: 'nope' },
      expect: { status: 'succeeded' },
    });
    expect(bad).toMatchObject({ passed: false, failures: ['inputs.userId: Expected a GUID.'] });
  });

  it('simulates transient errors through retries and runs non-dry tests against mocks', async () => {
    const retrying = playbook([read('a', '/a', { retry: { max: 2 } })], {
      tests: [
        { name: 'gives up', errors: { a: { status: 503 } }, expect: { status: 'failed', failedStep: 'a' } },
      ],
    });
    expect((await runPlaybookTests(retrying))[0]!.passed).toBe(true);
    const live = playbook([write('w'), { id: 'ok', type: 'approval' }, write('after')], {
      tests: [
        {
          name: 'parks',
          dryRun: false,
          mocks: { w: { id: 1 } },
          expect: { status: 'awaiting_approval', steps: { w: 'succeeded', ok: 'succeeded' } },
        },
      ],
    });
    const r = (await runPlaybookTests(live))[0]!;
    expect(r.status).toBe('awaiting_approval');
    expect(r.failures).toEqual(['steps.ok: expected succeeded, got waiting']);
  });

  it('fast-forwards wait steps and dry-runs child playbooks when given a resolver', async () => {
    const child = playbook([write('inner')], { id: 'test.child', inputs: { n: { type: 'number' } } });
    const parent = playbook(
      [
        { id: 'pause', type: 'wait', duration: 'PT1H' },
        {
          id: 'kid',
          type: 'playbook',
          mode: 'write',
          describe: 'Child',
          ref: 'test.child',
          inputs: { n: 1 },
        },
      ],
      {
        tests: [{ name: 'nested', dryRun: false, expect: { status: 'succeeded' } }],
      },
    );
    const r = (
      await runPlaybookTests(parent, { resolveChild: (ref) => (ref === 'test.child' ? child : null) })
    )[0]!;
    expect(r).toMatchObject({ passed: true, status: 'succeeded' });
    const missing = (await runPlaybookTests(parent))[0]!;
    expect(missing.failures[0]).toMatch(/no_mock/);
  });
});

describe('portal/content playbooks and runbooks: every tests: block passes', async () => {
  const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'), { references: false });
  const automation = loaded.definitions.filter((d) => d.def.kind === 'playbook' || d.def.kind === 'runbook');
  const byKey = new Map(automation.map((d) => [d.def.id, d.def]));
  it('content has playbooks', () => expect(automation.length).toBeGreaterThan(0));
  it.each(automation.map((d) => [d.file, d] as const))('%s', async (_file, d) => {
    const results = await runPlaybookTests(d.def as PlaybookDef, {
      resolveChild: (ref) => (byKey.get(ref) as PlaybookDef | undefined) ?? null,
    });
    expect(results.filter((r) => !r.passed).map((r) => `${r.name}: ${r.failures.join('; ')}`)).toEqual([]);
  });
});

describe('bulk definition', () => {
  const target = playbook([write('disable')], {
    id: 'identity.disable-user',
    title: 'Disable sign-in',
    inputs: { userId: { type: 'string' } },
  });

  it('wraps the target in a forEach of child playbook runs', () => {
    const b = bulkDefinition(target, { concurrency: 50 });
    expect(b.steps[0]).toMatchObject({
      id: BULK_LOOP_ID,
      type: 'forEach',
      items: '${ inputs.items }',
      concurrency: 10,
      onError: 'continue',
      steps: [
        {
          id: BULK_CHILD_ID,
          type: 'playbook',
          ref: 'identity.disable-user',
          version: '1.0.0',
          inputs: '${ item }',
        },
      ],
    });
    expect(bulkDefinition(target, { stopOnError: true }).steps[0]).toMatchObject({
      onError: 'fail',
      concurrency: 5,
    });
  });

  it('runs one child per item with the item as inputs, and counts results', async () => {
    const seen: unknown[] = [];
    const children: ChildRunner = {
      run: async (req) => {
        seen.push([req.path, req.inputs, req.dryRun]);
        const failed = req.inputs.userId === 'bad';
        return {
          runId: `c-${req.path}`,
          status: failed ? 'failed' : 'succeeded',
          outputs: {},
          error: failed ? { code: 'x', message: 'nope' } : null,
          plan: [],
        };
      },
    };
    const h = harness(bulkDefinition(target), {
      inputs: { items: [{ userId: 'a' }, { userId: 'bad' }, { userId: 'c' }] },
      engine: { children },
    });
    const out = await h.exec();
    expect(out).toMatchObject({ status: 'succeeded', outputs: { total: 3, succeeded: 2, failed: 1 } });
    expect(seen).toEqual([
      ['items[0].run', { userId: 'a' }, false],
      ['items[1].run', { userId: 'bad' }, false],
      ['items[2].run', { userId: 'c' }, false],
    ]);
    expect(h.record('items[1].run')?.error).toMatchObject({
      code: 'child_failed',
      message: 'Child playbook identity.disable-user ended failed: nope',
    });
  });

  it('a parked child parks the parent with the same status', async () => {
    const children: ChildRunner = {
      run: async (req) => ({
        runId: `c-${req.path}`,
        status: 'awaiting_approval',
        outputs: null,
        error: null,
        plan: [],
      }),
    };
    const h = harness(bulkDefinition(target), { inputs: { items: [{ userId: 'a' }] }, engine: { children } });
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(h.record('items[0].run')?.status).toBe('waiting');
  });
});
