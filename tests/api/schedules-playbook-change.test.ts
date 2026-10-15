import { ALL_ROLES, AVERY, BLAKE, FakeDefinitions, schedule, schedulesApp } from './schedules-helpers';

// The enable approval covers the playbook too: a new playbook version between request and approval voids it.
const playbook = (version: string) => ({
  kind: 'playbook' as const,
  id: 'identity.disable-user',
  version,
  title: 'Disable sign-in',
  mode: 'write',
  steps: [],
});
const content = () =>
  new FakeDefinitions().set(playbook('1.0.0')).set(
    schedule('ops.disable-stale', {
      cron: '0 3 * * *',
      job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write', approvedBy: ['review-1'] },
    }),
  );

describe('schedule enable approval and the playbook it runs', () => {
  it('approving records the playbook fingerprint on the schedule', async () => {
    const t = await schedulesApp({ defs: content() });
    const avery = await t.login(AVERY, ALL_ROLES);
    const blake = await t.login(BLAKE, ALL_ROLES);
    const { approvalId } = (await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).json();
    expect((await blake.post(`/api/approvals/${approvalId}`, { decision: 'approve' })).json()).toMatchObject({
      status: 'approved',
    });
    const row = await t.schedules.store.getSchedule('ops.disable-stale');
    expect(row).toMatchObject({ enabled: true, approvedBy: 'blake@example.com' });
    expect(row!.approvedTarget).toMatch(/^[0-9a-f]{64}$/);
    await t.close();
  });

  it('a playbook published after the request voids the approval', async () => {
    const defs = content();
    const t = await schedulesApp({ defs });
    const avery = await t.login(AVERY, ALL_ROLES);
    const blake = await t.login(BLAKE, ALL_ROLES);
    const { approvalId } = (await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).json();
    defs.set(playbook('1.1.0'));
    const res = await blake.post(`/api/approvals/${approvalId}`, { decision: 'approve' });
    expect(res.json().error.code).toBe('definition_changed');
    expect((await t.schedules.store.getSchedule('ops.disable-stale'))!.enabled).toBe(false);
    await t.close();
  });
});
