import type { CreatorAccessChecker, CreatorVerdict } from '@adminforge/api/src/schedules/creator-access';
import {
  grantPartition,
  MemoryScheduleGrantStore,
  ScheduleIdentities,
} from '@adminforge/api/src/schedules/grants';
import type { AuthClient, IdClaims } from '@adminforge/api/src/auth/types';
import { Schedule } from '@adminforge/schemas';
import { flush, harness } from './helpers';

// When the creator of a schedule that runs with their own access (ADR-014) loses access, nothing of theirs outlives
// it: whichever check notices — the directory check before the run (creatorAccess) or Entra refusing their roles on
// refresh — the schedule is turned off (audited `schedule.disabled`) and their grant and its sealed tokens are removed.
// Without the account-status claim the run doesn't happen, but the grant stays (can't tell, so fail closed).

const AVERY = '00000000-0000-4000-8000-0000000000a1';
const KEY = 'portal.identity-x-c0ffee';
const NOW = new Date('2026-10-15T12:00:00Z');

class FakeAccess implements CreatorAccessChecker {
  constructor(public verdict: CreatorVerdict = { status: 'ok' }) {}
  async check() {
    return this.verdict;
  }
}

async function setup(verdict: CreatorVerdict, claims: Partial<IdClaims> = {}) {
  const grants = new MemoryScheduleGrantStore();
  const deleted: string[] = [];
  const auth = {
    refreshClaims: async () => ({
      oid: AVERY,
      tid: 't',
      roles: ['Portal.Operator', 'Portal.Reader'],
      acct: 0,
      ...claims,
    }),
  };
  const h = harness({
    creatorAccess: new FakeAccess(verdict),
    identities: new ScheduleIdentities({
      grants,
      auth: auth as unknown as AuthClient,
      tokenCache: { delete: async (k: string) => void deleted.push(k) },
      now: () => NOW,
    }),
  });
  h.defs.set({
    kind: 'report',
    id: 'identity.x',
    version: '1.0.0',
    title: 'X',
    owner: 'identity-team',
  } as never);
  const def = Schedule.parse({
    kind: 'schedule',
    id: KEY,
    version: '1.0.0',
    title: 'X weekly, with my access',
    owner: 'avery@example.com',
    cron: '0 * * * *',
    identity: { user: 'creator' },
    job: { kind: 'report', ref: 'identity.x', delivery: [{ type: 'file', format: 'csv' }] },
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
  await grants.put({
    scheduleId: row.id,
    userOid: AVERY,
    upn: 'avery@example.com',
    homeAccountId: 'home-1',
    status: 'active',
    reason: null,
    consentedAt: NOW,
    checkedAt: null,
  });
  await h.scheduler.start();
  await flush();
  await h.clock.advance(3_600_000);
  await h.scheduler.drain();
  const run = (await h.store.listRuns(row.id, { limit: 5 }))[0];
  return { h, row, grants, deleted, run };
}

describe('a creator schedule whose creator lost access', () => {
  it('the directory check confirms the loss: turned off, grant and tokens removed, audited', async () => {
    const { h, row, grants, deleted, run } = await setup({
      status: 'removed',
      reason: 'missing_role',
      missing: ['Portal.Operator'],
    });
    expect(h.jobs.calls).toEqual([]);
    expect(run).toMatchObject({ status: 'failed', error: { code: 'creator_access_removed' } });
    expect(await h.store.getSchedule(KEY)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(await grants.get(row.id)).toBeNull();
    expect(deleted).toEqual([grantPartition(row.id)]);
    expect(h.audit.rows.find((r) => r.action === 'schedule.disabled')).toMatchObject({
      targetId: KEY,
      details: { reason: 'creator_access_removed', detail: 'missing_role', grantRemoved: true },
    });
  });

  it('Entra’s refreshed roles show the loss: turned off too (not failing and alerting every hour)', async () => {
    const { h, row, grants, run } = await setup({ status: 'ok' }, { roles: ['Portal.Reader'] });
    expect(run).toMatchObject({ status: 'failed', error: { code: 'creator_access_removed' } });
    expect(await h.store.getSchedule(KEY)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(await grants.get(row.id)).toBeNull();
    expect(h.audit.rows.find((r) => r.action === 'schedule.disabled')).toMatchObject({
      details: { reason: 'creator_access_removed', detail: 'roles', missingRoles: ['Portal.Operator'] },
    });
  });

  it('no account-status claim: the run doesn’t happen, the grant and the schedule stay', async () => {
    const { h, row, grants, run } = await setup({ status: 'ok' }, { acct: undefined });
    expect(h.jobs.calls).toEqual([]);
    expect(run).toMatchObject({ status: 'failed', error: { code: 'creator_unverified' } });
    expect(await h.store.getSchedule(KEY)).toMatchObject({ enabled: true });
    expect(await grants.get(row.id)).toMatchObject({ status: 'active' });
  });
});
