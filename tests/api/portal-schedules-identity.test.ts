import { ApiErrorBody } from '@adminforge/schemas';
import { AVERY, OPERATOR, READER, body, portalApp } from './portal-schedules-helpers';

// "Run as" on a report schedule made in the portal (ADR-014): the automation identity (default), an app identity this
// AdminForge has configured, or — only where people sign in with Entra — the creator's own access.

const error = (res: { json(): unknown }) => ApiErrorBody.parse(res.json()).error;
const IDENTITIES = {
  AF_SCHEDULE_IDENTITIES: 'reports-team',
  AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: '00000000-0000-4000-8000-00000000a001',
};

describe('portal schedules: run as', () => {
  it('offers the configured app identities, and says whether creators’ access can be used', async () => {
    const t = await portalApp({ config: IDENTITIES });
    const op = await t.login(AVERY, OPERATOR);
    expect((await op.get('/api/schedules/delivery-options')).json().identities).toEqual({
      apps: ['reports-team'],
      user: false,
    });
    await t.close();
  });

  it('a Reader can see the run-as choices (for the schedule editor), names only', async () => {
    const t = await portalApp({ config: IDENTITIES });
    const reader = await t.login(READER, ['Portal.Reader']);
    const res = await reader.get('/api/schedules/identities');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apps: ['reports-team'], user: false });
    expect(res.body).not.toContain(IDENTITIES.AF_IDENTITY_REPORTS_TEAM_CLIENT_ID);
    expect((await reader.get('/api/schedules/delivery-options')).statusCode).toBe(403);
    await t.close();
  });

  it('runs as a configured app identity: stored on the definition, shown on the item', async () => {
    const t = await portalApp({ config: IDENTITIES });
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', body({ identity: { app: 'reports-team' } }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      identity: 'app:reports-team',
      runsAs: { kind: 'app', name: 'reports-team', label: 'app identity reports-team' },
    });
    const row = await t.schedules.store.getSchedule(res.json().key);
    expect(row!.definition.identity).toEqual({ app: 'reports-team' });
    await t.close();
  });

  it('refuses an app identity this AdminForge doesn’t have', async () => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', body({ identity: { app: 'reports-team' } }));
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({ code: 'identity_not_configured' });
    expect(await t.schedules.store.listSchedules()).toHaveLength(0);
    await t.close();
  });

  it('refuses the creator’s own access without Entra sign-in', async () => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', body({ identity: { user: 'creator' } }));
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({ code: 'user_identity_unavailable' });
    await t.close();
  });
});
