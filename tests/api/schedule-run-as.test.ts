import {
  ALL_ROLES,
  AVERY,
  BLAKE,
  FakeDefinitions,
  READER,
  schedule,
  schedulesApp,
} from './schedules-helpers';

// Which account a content schedule runs as (docs/plans/2026-10-23-run-as-and-vault.md): the installation default for
// its kind, until an Operator chooses another on its page; the choice is audited, and a write-capable schedule's
// approval covers the account it runs as.

const config = {
  AF_SCHEDULE_IDENTITIES: 'reports-team,ops-team',
  AF_SCHEDULE_DEFAULT_IDENTITY: 'reports-team',
  AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: '00000000-0000-4000-8000-0000000000d1',
  AF_IDENTITY_OPS_TEAM_CLIENT_ID: '00000000-0000-4000-8000-0000000000d2',
};
const playbook = {
  kind: 'playbook' as const,
  id: 'identity.disable-user',
  version: '1.0.0',
  title: 'Disable sign-in',
  mode: 'write',
  steps: [],
};
const lookup = { ...playbook, id: 'identity.lookup-user', title: 'Look up a user', mode: 'read' };
const defs = () =>
  new FakeDefinitions()
    .set(playbook)
    .set(lookup)
    .set(schedule('ops.lookup', { job: { kind: 'playbook', ref: 'identity.lookup-user', mode: 'read' } }))
    .set(schedule('probes.sweep'))
    .set(schedule('news.collect', { job: { kind: 'news' } }))
    .set(
      schedule('ops.disable-stale', {
        cron: '0 3 * * *',
        job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write', approvedBy: ['approval-1'] },
      }),
    );

async function setup() {
  const t = await schedulesApp({ defs: defs(), config });
  const avery = await t.login(AVERY, ALL_ROLES);
  const blake = await t.login(BLAKE, ALL_ROLES);
  const reader = await t.login(READER, ['Portal.Reader']);
  return { t, avery, blake, reader };
}

describe('PUT /api/schedules/:key/run-as', () => {
  it('runs as the default for its kind until an Operator chooses another, then back', async () => {
    const { t, avery } = await setup();
    const before = (await avery.get('/api/schedules/ops.lookup')).json();
    expect(before.identity).toBe('app:reports-team');
    expect(before.runsAs).toMatchObject({ kind: 'app', name: 'reports-team', source: 'default' });

    const set = await avery.put('/api/schedules/ops.lookup/run-as', { identity: 'app:ops-team' });
    expect(set.statusCode).toBe(200);
    expect(set.json().identity).toBe('app:ops-team');
    expect(set.json().runsAs).toMatchObject({ name: 'ops-team', source: 'override', setBy: AVERY.upn });
    expect(t.audit.rows.find((r) => r.action === 'schedule.run_as_changed')).toMatchObject({
      actorUpn: AVERY.upn,
      targetId: 'ops.lookup',
      details: { from: 'app:reports-team', to: 'app:ops-team', override: 'app:ops-team', disabled: false },
    });

    const cleared = (await avery.put('/api/schedules/ops.lookup/run-as', { identity: null })).json();
    expect(cleared.runsAs).toMatchObject({ name: 'reports-team', source: 'default' });
    expect(cleared.runsAs.setBy).toBeUndefined();
    await t.close();
  });

  it('is for Operators, and names only identities this AdminForge has', async () => {
    const { t, avery, reader } = await setup();
    expect(
      (await reader.put('/api/schedules/probes.sweep/run-as', { identity: 'automation' })).statusCode,
    ).toBe(403);
    for (const identity of ['app:nobody', 'user', 'app:Ops', 'reports-team']) {
      const r = await avery.put('/api/schedules/probes.sweep/run-as', { identity });
      expect(r.statusCode, identity).toBe(400);
      expect(r.json().error.code).toBe('unknown_identity');
    }
    const news = await avery.put('/api/schedules/news.collect/run-as', { identity: 'app:ops-team' });
    expect([news.statusCode, news.json().error.code]).toEqual([409, 'run_as_fixed']);
    await t.close();
  });

  it('a write-capable schedule takes no default, and its approval covers the account it runs as', async () => {
    const { t, avery, blake } = await setup();
    expect((await avery.get('/api/schedules/ops.disable-stale')).json().runsAs).toMatchObject({
      source: 'automation',
    });

    // Requested for the automation identity; the account changes before Blake approves → the approval lapses.
    expect((await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).statusCode).toBe(202);
    const [first] = (await blake.get('/api/approvals?status=pending')).json().items;
    expect(first.policy.identity).toBe('automation');
    expect(
      (await avery.put('/api/schedules/ops.disable-stale/run-as', { identity: 'app:ops-team' })).json(),
    ).toMatchObject({ identity: 'app:ops-team' });
    // The change cancelled the request: it can't be approved for the old account any more.
    const stale = await blake.post(`/api/approvals/${first.id}`, { decision: 'approve' });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'already_decided']);

    // Asked again for the new account and approved: enabled. Changing the account turns it off.
    expect((await avery.patch('/api/schedules/ops.disable-stale', { enabled: true })).statusCode).toBe(202);
    const [second] = (await blake.get('/api/approvals?status=pending')).json().items;
    expect(second.policy.identity).toBe('app:ops-team');
    expect(second.policy.message).toContain('as app identity ops-team.');
    expect((await blake.post(`/api/approvals/${second.id}`, { decision: 'approve' })).statusCode).toBe(200);
    expect((await avery.get('/api/schedules/ops.disable-stale')).json().enabled).toBe(true);

    const moved = await avery.put('/api/schedules/ops.disable-stale/run-as', { identity: 'automation' });
    expect(moved.json()).toMatchObject({ disabled: true, enabled: false, identity: 'automation' });
    expect(t.audit.rows.filter((r) => r.action === 'schedule.run_as_changed').at(-1)).toMatchObject({
      details: { from: 'app:ops-team', to: 'automation', disabled: true },
    });
    await t.close();
  });
});
