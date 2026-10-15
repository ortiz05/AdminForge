import { automationFingerprint, childRefs } from '@adminforge/api/src/runs/fingerprint';
import { Playbook } from '@adminforge/schemas';
import { mockConfig } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// A schedule's two-person approval covers the playbook versions it runs, not just the schedule definition.
const USER = '00000000-0000-4000-8000-000000000001';
const disable = (version: string, extraStep = false) =>
  ({
    kind: 'playbook',
    id: 'test.disable',
    title: 'Disable sign-in',
    owner: 'tests',
    version,
    risk: 'low',
    mode: 'write',
    inputs: { userId: { type: 'string', format: 'guid' } },
    steps: [
      {
        id: 'disable',
        type: 'graph',
        mode: 'write',
        describe: 'Disable sign-in',
        request: {
          method: 'PATCH',
          path: '/users/${ $encode(inputs.userId) }',
          body: { accountEnabled: false },
        },
      },
      ...(extraStep
        ? [
            {
              id: 'delete',
              type: 'graph',
              mode: 'write',
              describe: 'Delete the user',
              request: { method: 'DELETE', path: '/users/${ $encode(inputs.userId) }' },
            },
          ]
        : []),
      { id: 'notify', type: 'playbook', ref: 'test.child' },
    ],
  }) as never;
const child = (version: string) =>
  ({
    kind: 'playbook',
    id: 'test.child',
    title: 'Child',
    owner: 'tests',
    version,
    risk: 'low',
    mode: 'read',
    steps: [{ id: 'noop', type: 'transform', expression: '${ 1 }' }],
  }) as never;

async function setup() {
  const definitions = new StaticDefinitions().add(child('1.0.0')).add(disable('1.0.0'));
  const t = await runsApp({ config: mockConfig(), definitions, outbound: new FakeExecutor(() => null) });
  const fingerprint = () =>
    automationFingerprint((r, v) => t.runs.service.resolve(r, v), { ref: 'test.disable' });
  const schedule = async () => ({
    key: 'ops.nightly-disable',
    createdBy: AVERY.oid,
    approvedBy: [BLAKE.oid],
    approvedTarget: await fingerprint(),
  });
  return { t, definitions, fingerprint, schedule };
}

describe('schedule approvals are bound to the playbook versions they approved', () => {
  it('childRefs finds child playbook steps', () => {
    expect(childRefs(Playbook.parse(disable('1.0.0')))).toEqual([{ ref: 'test.child', version: undefined }]);
  });

  it('runs while the playbook is unchanged', async () => {
    const { t, schedule } = await setup();
    const row = await t.runs.service.createScheduledRun({
      schedule: await schedule(),
      playbook: 'test.disable',
      inputs: { userId: USER },
    });
    expect(row.identity).toBe('automation');
  });

  it('refuses after a new version of the playbook is published, and audits it', async () => {
    const { t, definitions, schedule } = await setup();
    const approved = await schedule();
    definitions.add(disable('1.1.0', true));
    await expect(
      t.runs.service.createScheduledRun({
        schedule: approved,
        playbook: 'test.disable',
        inputs: { userId: USER },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'approval_outdated' });
    expect(t.audit.rows.some((r) => r.action === 'schedule.approval_outdated' && r.result === 'denied')).toBe(
      true,
    );
  });

  it('refuses after a child playbook changes', async () => {
    const { t, definitions, schedule } = await setup();
    const approved = await schedule();
    definitions.add(child('1.0.1'));
    await expect(
      t.runs.service.createScheduledRun({
        schedule: approved,
        playbook: 'test.disable',
        inputs: { userId: USER },
      }),
    ).rejects.toMatchObject({ code: 'approval_outdated' });
  });

  it('a write schedule without an approved fingerprint never runs (content approvedBy is not proof)', async () => {
    const { t } = await setup();
    await expect(
      t.runs.service.createScheduledRun({
        schedule: { key: 'ops.nightly-disable', approvedBy: ['approval-1'] },
        playbook: 'test.disable',
        inputs: { userId: USER },
      }),
    ).rejects.toMatchObject({ code: 'approval_outdated' });
  });
});
