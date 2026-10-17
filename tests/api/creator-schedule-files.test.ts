import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Schedule } from '@adminforge/schemas';
import { ALL_ROLES, AVERY, BLAKE, DANA, OPERATOR, portalApp } from './portal-schedules-helpers';

// A schedule that runs with its creator's own access (ADR-014) collected what *they* can see — their directory roles,
// data a ceiling withholds from the automation identity. Its files are the creator's: another Operator holding the
// report's roles gets neither the file nor a link to it; a Portal Admin can open it, audited as an admin override.

const KEY = 'portal.identity-inactive-users-c0ffee';

async function withCreatorSchedule() {
  const t = await portalApp();
  const def = Schedule.parse({
    kind: 'schedule',
    id: KEY,
    version: '1.0.0',
    title: 'Inactive users, with my access',
    owner: AVERY.upn,
    cron: '0 6 * * 1',
    identity: { user: 'creator' },
    job: { kind: 'report', ref: 'identity.inactive-users', delivery: [{ type: 'file', format: 'csv' }] },
    requires: { portalRoles: ['Portal.Operator'] },
  });
  const row = (await t.schedules.store.insertSchedule({
    key: KEY,
    source: 'portal',
    definition: def,
    sha256: 'sha-creator',
    enabled: true,
    nextRunAt: null,
    createdBy: AVERY.oid,
  }))!;
  mkdirSync(path.join(t.artifactsDir, KEY), { recursive: true });
  writeFileSync(path.join(t.artifactsDir, KEY, '2026-10-15T06-00-00Z.csv'), 'Name\r\nsynthetic\r\n');
  const run = await t.schedules.store.insertRun({
    scheduleId: row.id,
    scheduleKey: KEY,
    trigger: 'cron',
    status: 'succeeded',
    artifactPath: `${KEY}/2026-10-15T06-00-00Z.csv`,
    startedAt: new Date('2026-10-15T06:00:00Z'),
    endedAt: new Date('2026-10-15T06:01:00Z'),
  });
  return { t, run };
}

describe('files of a schedule that runs with its creator’s access', () => {
  it('the creator downloads them; another Operator gets no link and a refusal', async () => {
    const { t, run } = await withCreatorSchedule();
    const creator = await t.login(AVERY, OPERATOR);
    const other = await t.login(BLAKE, OPERATOR);
    expect((await creator.get(`/api/artifacts/${run.id}`)).statusCode).toBe(200);
    expect((await creator.get(`/api/schedules/${KEY}/runs`)).json().items[0].artifact).toBeDefined();

    const refused = await other.get(`/api/artifacts/${run.id}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(
      'Only the person who created this schedule can open its files.',
    );
    const runs = (await other.get(`/api/schedules/${KEY}/runs`)).json().items;
    expect(runs).toHaveLength(1);
    expect(runs[0].artifact).toBeUndefined();
    await t.close();
  });

  it('a Portal Admin can open them, audited as an admin override', async () => {
    const { t, run } = await withCreatorSchedule();
    const admin = await t.login(DANA, ALL_ROLES);
    expect((await admin.get(`/api/artifacts/${run.id}`)).statusCode).toBe(200);
    expect(t.audit.rows.find((r) => r.action === 'artifact.downloaded')).toMatchObject({
      actorOid: DANA.oid,
      details: { schedule: KEY, adminOverride: true },
    });
    await t.close();
  });
});
