import { automationFingerprint, writesInTree } from '@adminforge/api/src/runs/fingerprint';
import { AppError } from '@adminforge/api/src/errors';
import { Playbook } from '@adminforge/schemas';
import { mockConfig } from './helpers';
import { ALL_ROLES, AVERY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

const USER = '00000000-0000-4000-8000-000000000001';
const lookup = {
  id: 'lookup',
  type: 'graph',
  mode: 'read',
  request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
};
const disable = {
  id: 'disable',
  type: 'graph',
  mode: 'write',
  describe: 'Disable',
  request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } },
};
const inputs = { userId: { type: 'string', format: 'guid' } };
const base = { owner: 'tests', version: '1.0.0', inputs } as const;

describe('a preview starts at most one run (L6)', () => {
  it('replaying a confirmed preview is refused; the first run stands', async () => {
    const defs = new StaticDefinitions().add({
      kind: 'playbook',
      id: 'test.click',
      title: 'Disable (click)',
      risk: 'high',
      mode: 'write',
      steps: [lookup, disable],
      confirm: { type: 'click' },
      ...base,
    } as never);
    const t = await runsApp({
      config: mockConfig(),
      definitions: defs,
      outbound: new FakeExecutor((c) => (c.method === 'GET' ? { upn: 'a@example.com' } : null)),
    });
    const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
    const dry = await avery.post('/api/runs', {
      playbook: 'test.click',
      inputs: { userId: USER },
      dryRun: true,
    });
    await t.drain();
    const previewRunId = dry.json().runId as string;
    const body = { playbook: 'test.click', inputs: { userId: USER }, previewRunId };
    const first = await avery.post('/api/runs', body);
    expect(first.statusCode).toBe(202);
    const again = await avery.post('/api/runs', body);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      code: 'preview_stale',
      message: expect.stringMatching(/already used/),
      hint: expect.stringMatching(/Preview/),
    });
    await t.drain();
    const writes = t.outbound.calls.filter((c) => c.call.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(
      t.audit.rows.filter((r) => r.action === 'run.created' && r.details?.dryRun === false),
    ).toHaveLength(1);
    await t.close();
  });
});

describe('scheduled runs: write capability and approval cover the whole tree (L7, M8)', () => {
  const tree = () =>
    new StaticDefinitions()
      // Top level reads (as the schedule says) but starts a child that writes.
      .add({
        kind: 'playbook',
        id: 'test.parent',
        title: 'Parent',
        risk: 'low',
        mode: 'read',
        steps: [
          { id: 'child', type: 'playbook', ref: 'test.child', inputs: { userId: '${ inputs.userId }' } },
        ],
        ...base,
      } as never)
      .add({
        kind: 'playbook',
        id: 'test.child',
        title: 'Child',
        risk: 'low',
        mode: 'write',
        steps: [disable],
        ...base,
      } as never);

  it('a read-only top level that starts a write child still needs the second approval', async () => {
    const t = await runsApp({ config: mockConfig(), definitions: tree(), outbound: new FakeExecutor() });
    await expect(
      t.runs.service.createScheduledRun({
        schedule: { key: 'ops.sneaky', createdBy: 'content (owner: tests)' },
        playbook: 'test.parent',
        inputs: { userId: USER },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'two_person_required' });
    // A dry run still needs none.
    await expect(
      t.runs.service.createScheduledRun({
        schedule: { key: 'ops.sneaky' },
        playbook: 'test.parent',
        inputs: { userId: USER },
        dryRun: true,
      }),
    ).resolves.toMatchObject({ dryRun: true });
    await t.close();
  });

  it('writesInTree follows children; a missing child is reported', async () => {
    const defs = tree();
    const resolve = (r: string, v?: string) => defs.resolve('playbook', r, v);
    const writes = (d: { mode: string }) => d.mode === 'write';
    expect(await writesInTree(resolve as never, { ref: 'test.parent' }, writes as never)).toBe(true);
    expect(await writesInTree(resolve as never, { ref: 'test.child' }, writes as never)).toBe(true);
    await expect(
      writesInTree(resolve as never, { ref: 'test.nope' }, writes as never),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('the approval fingerprint covers the connections function steps call', async () => {
    const pb = Playbook.parse({
      kind: 'playbook',
      id: 'test.hr',
      version: '1.0.0',
      title: 'HR sync',
      owner: 'tests',
      risk: 'low',
      mode: 'write',
      steps: [
        {
          id: 'sync',
          type: 'function',
          mode: 'write',
          describe: 'Sync',
          connection: 'hr.sync',
          operation: 'sync',
          compensate: { type: 'function', connection: 'hr.undo', operation: 'undo' },
        },
      ],
    });
    const resolve = async () => ({ def: pb, version: '1.0.0', sha256: 'pb-sha' });
    const versions: Record<string, string> = { 'hr.sync': '1.0.0', 'hr.undo': '1.0.0' };
    const connection = async (key: string) => ({
      version: versions[key]!,
      sha256: `${key}@${versions[key]}`,
    });
    const before = await automationFingerprint(resolve, { ref: 'test.hr' }, connection);
    expect(await automationFingerprint(resolve, { ref: 'test.hr' }, connection)).toBe(before);
    versions['hr.undo'] = '1.1.0';
    expect(await automationFingerprint(resolve, { ref: 'test.hr' }, connection)).not.toBe(before);
    // Without a way to resolve connections the fingerprint refuses rather than leaving them out.
    await expect(automationFingerprint(resolve, { ref: 'test.hr' })).rejects.toThrow(/connection/);
  });
});
