import { ALL_ROLES, AVERY, BLAKE, FakeDefinitions, schedule, schedulesApp } from './schedules-helpers';

// Asking a second person to enable a write schedule names who it will run as (ADR-014): the approval message and the
// `schedule.enable_requested` audit event say "app identity identity-ops", not the automation identity.

const playbook = {
  kind: 'playbook' as const,
  id: 'identity.disable-user',
  version: '1.0.0',
  title: 'Disable sign-in',
  mode: 'write',
  steps: [],
};

function content(identity: unknown) {
  return new FakeDefinitions().set(playbook).set(
    schedule('ops.disable-stale', {
      cron: '0 3 * * *',
      identity,
      job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write', approvedBy: ['approval-1'] },
    }),
  );
}

describe('approval to enable a write schedule: who it runs as', () => {
  it.each([
    [{ app: 'identity-ops' }, 'as app identity identity-ops.', 'app:identity-ops'],
    ['automation', 'as the automation identity.', 'automation'],
  ])('%j', async (identity, phrase, key) => {
    const t = await schedulesApp({ defs: content(identity) });
    const avery = await t.login(AVERY, ALL_ROLES);
    const blake = await t.login(BLAKE, ALL_ROLES);
    expect((await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).statusCode).toBe(202);
    const [approval] = (await blake.get('/api/approvals?status=pending')).json().items;
    expect(approval.policy.message).toContain(`${phrase} A second person must approve.`);
    expect(t.audit.rows.find((r) => r.action === 'schedule.enable_requested')).toMatchObject({
      details: { identity: key },
    });
    await t.close();
  });
});
