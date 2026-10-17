import {
  grantPartition,
  MemoryScheduleGrantStore,
  ScheduleIdentities,
  type ScheduleGrantRow,
} from '@adminforge/api/src/schedules/grants';
import { ReauthRequired, type AuthClient, type IdClaims } from '@adminforge/api/src/auth/types';
import { Schedule } from '@adminforge/schemas';
import { flush, harness } from './helpers';

// Who a schedule runs as (ADR-014). The scheduler asks ScheduleIdentities before each run: an app identity runs as
// that app; a creator schedule re-reads the creator's roles with Entra (refreshClaims) and runs with their stored
// grant — or stops: "needs sign-in" (refused refresh, never signed in), or "creator_access_removed" (lost a role; the
// grant and its tokens are dropped). A schedule already waiting for sign-in is skipped quietly, not failed again.

const AVERY = '00000000-0000-4000-8000-0000000000a1';
const KEY = 'portal.identity-x-abc123';
const NOW = new Date('2026-10-15T12:00:00Z');

class FakeAuth {
  refreshes = 0;
  next: () => IdClaims = () => ({
    oid: AVERY,
    tid: 't',
    name: 'Avery Lee',
    roles: ['Portal.Operator', 'Portal.Reader'],
    acct: 0,
  });
  async refreshClaims() {
    this.refreshes++;
    return this.next();
  }
}

const report = { kind: 'report', id: 'identity.x', version: '1.0.0', title: 'X', owner: 'identity-team' };

async function setup(identity: unknown, grant?: Partial<ScheduleGrantRow> | null) {
  const grants = new MemoryScheduleGrantStore();
  const auth = new FakeAuth();
  const deleted: string[] = [];
  const h = harness({
    identities: new ScheduleIdentities({
      grants,
      auth: auth as unknown as AuthClient,
      tokenCache: { delete: async (k: string) => void deleted.push(k) },
      now: () => NOW,
    }),
  });
  h.defs.set(report as never);
  const def = Schedule.parse({
    kind: 'schedule',
    id: KEY,
    version: '1.0.0',
    title: 'X weekly',
    owner: 'avery@example.com',
    cron: '0 * * * *',
    identity,
    job: { kind: 'report', ref: 'identity.x', delivery: [{ type: 'file', format: 'csv' }] },
    notify: { onFailure: [{ type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'] }] },
  });
  const row = (await h.store.insertSchedule({
    key: KEY,
    source: 'portal',
    definition: def,
    sha256: 'sha-1',
    enabled: true,
    nextRunAt: new Date('2026-10-15T13:00:00Z'),
    createdBy: AVERY,
  }))!;
  if (grant !== null && grant !== undefined)
    await grants.put({
      scheduleId: row.id,
      userOid: AVERY,
      upn: 'avery@example.com',
      homeAccountId: 'home-1',
      status: 'active',
      reason: null,
      consentedAt: NOW,
      checkedAt: null,
      ...grant,
    });
  await h.scheduler.start();
  await flush();
  const runs = async () => (await h.store.listRuns(row.id, { limit: 50 })).reverse();
  const fire = async () => {
    await h.clock.advance(3_600_000);
    await h.scheduler.drain();
  };
  return { h, row, grants, auth, deleted, runs, fire };
}

describe('schedule identities', () => {
  it('a named app identity: the job runs as that app, audited as it', async () => {
    const { h, fire } = await setup({ app: 'reports-team' });
    await fire();
    expect(h.jobs.calls[0]!.identity).toEqual({
      kind: 'automation',
      mode: 'read',
      app: 'reports-team',
      schedule: KEY,
    });
    expect(h.audit.rows.find((r) => r.action === 'schedule.run')!.details).toMatchObject({
      summary: 'Scheduled by avery@example.com, executed as app identity reports-team.',
      executedAs: 'app identity reports-team',
    });
  });

  it('the creator: roles re-read, then the job runs with their grant (Read app partition of this schedule)', async () => {
    const { h, row, auth, fire, grants } = await setup({ user: 'creator' }, {});
    await fire();
    expect(auth.refreshes).toBe(1);
    expect(h.jobs.calls[0]!.identity).toEqual({
      kind: 'grant',
      mode: 'read',
      grant: {
        scheduleId: row.id,
        scheduleKey: KEY,
        oid: AVERY,
        upn: 'avery@example.com',
        homeAccountId: 'home-1',
        partitionKey: grantPartition(row.id),
      },
    });
    expect(h.jobs.calls[0]!.user).toEqual({
      oid: AVERY,
      upn: 'avery@example.com',
      name: 'Avery Lee',
      roles: ['Portal.Operator', 'Portal.Reader'],
    });
    expect((await grants.get(row.id))!.checkedAt).toEqual(NOW);
    expect(h.audit.rows.find((r) => r.action === 'schedule.run')!.details).toMatchObject({
      executedAs: 'avery@example.com (their own access)',
    });
  });

  it('never signed in: the run fails needs_sign_in (no retry), nothing ran', async () => {
    const { h, runs, fire } = await setup({ user: 'creator' }, null);
    await fire();
    expect(h.jobs.calls).toEqual([]);
    expect((await runs())[0]).toMatchObject({
      status: 'failed',
      error: { code: 'needs_sign_in', message: expect.stringMatching(/haven’t signed in for it yet/) },
    });
  });

  it('Entra refuses the refresh: needs sign-in is stored, the first run fails and notifies, later ones are skipped quietly', async () => {
    const { h, row, auth, grants, runs, fire } = await setup({ user: 'creator' }, {});
    auth.next = () => {
      throw new ReauthRequired('read');
    };
    await fire();
    expect(h.jobs.calls).toEqual([]);
    expect(await grants.get(row.id)).toMatchObject({ status: 'needs_sign_in', reason: 'reauth' });
    expect((await runs())[0]).toMatchObject({ status: 'failed', error: { code: 'needs_sign_in' } });
    expect(h.audit.rows.filter((r) => r.action === 'schedule.failed')).toHaveLength(1);
    await fire();
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ status: 'skipped', error: { code: 'needs_sign_in' } });
    // Still one failure and no new refresh attempt: nothing is asked of Entra until the creator signs in again.
    expect(h.audit.rows.filter((r) => r.action === 'schedule.failed')).toHaveLength(1);
    expect(auth.refreshes).toBe(1);
  });

  it('the creator lost a role: creator_access_removed, the grant and its sealed tokens are dropped', async () => {
    const { h, row, auth, grants, deleted, runs, fire } = await setup({ user: 'creator' }, {});
    auth.next = () => ({ oid: AVERY, tid: 't', roles: ['Portal.Reader'], acct: 0 });
    await fire();
    expect(h.jobs.calls).toEqual([]);
    expect((await runs())[0]).toMatchObject({
      status: 'failed',
      error: { code: 'creator_access_removed', message: expect.stringMatching(/Portal\.Operator/) },
    });
    expect(await grants.get(row.id)).toBeNull();
    expect(deleted).toEqual([grantPartition(row.id)]);
  });

  it('Microsoft refuses the stored access mid-run (reauth): the schedule now needs sign-in', async () => {
    const { h, row, grants, runs, fire } = await setup({ user: 'creator' }, {});
    h.jobs.respond = () => ({
      status: 'failed',
      error: { code: 'reauth', message: 'Microsoft needs you to sign in again.' },
    });
    await fire();
    expect(await grants.get(row.id)).toMatchObject({ status: 'needs_sign_in' });
    expect((await runs())[0]).toMatchObject({ status: 'failed', error: { code: 'needs_sign_in' } });
  });

  it('a grant that belongs to someone else is never used', async () => {
    const { h, row, grants, runs, fire } = await setup(
      { user: 'creator' },
      { userOid: '00000000-0000-4000-8000-0000000000b2' },
    );
    await fire();
    expect(h.jobs.calls).toEqual([]);
    expect(await grants.get(row.id)).toBeNull();
    expect((await runs())[0]).toMatchObject({ status: 'failed', error: { code: 'needs_sign_in' } });
  });
});
