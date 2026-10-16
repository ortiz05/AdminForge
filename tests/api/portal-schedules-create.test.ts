import { createHash } from 'node:crypto';
import { canonical } from '@adminforge/api/src/audit/chain';
import { ApiErrorBody, Schedule } from '@adminforge/schemas';
import { flush } from '../unit/scheduler/helpers';
import { FakeJobs } from './schedules-helpers';
import {
  ALL_ROLES,
  AVERY,
  BLAKE,
  DANA,
  OPERATOR,
  READER,
  body,
  inactiveUsers,
  portalApp,
  reportDefs,
} from './portal-schedules-helpers';

// POST /api/schedules: an Operator schedules a report in the portal. It runs at once (no git review), so the server
// enforces the narrow shape: report jobs only, the report's roles, its export and formats, params validated as the
// automation identity, at most hourly, delivery only to configured keys, caps, and an audit record.

const error = (res: { json(): unknown }) => ApiErrorBody.parse(res.json()).error;

describe('POST /api/schedules', () => {
  it('creates an enabled portal schedule: valid definition, row, next run, event and audit', async () => {
    const t = await portalApp();
    const events: string[] = [];
    t.schedules.events.on((e) => events.push(e.type));
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post(
      '/api/schedules',
      body(
        { summary: 'For the identity team.' },
        {
          params: { days: '90', includeGuests: true, department: '' },
          emailKey: 'AF_REPORT_RECIPIENTS',
          teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK',
        },
      ),
    );
    expect(res.statusCode).toBe(201);
    const item = res.json();
    expect(item.key).toMatch(/^portal\.identity-inactive-users-[0-9a-f]{6}$/);
    expect(item).toMatchObject({
      title: 'Inactive users, weekly',
      summary: 'For the identity team.',
      cron: '0 6 * * 1',
      cronText: 'Every Monday at 06:00',
      timezone: 'Europe/London',
      enabled: true,
      identity: 'automation',
      // The value the run will get ("90" → 90); empty values are left to the report's default.
      job: { kind: 'report', ref: 'identity.inactive-users', params: { days: 90, includeGuests: true } },
      nextRunAt: '2026-10-19T05:00:00.000Z',
      writeCapable: false,
      source: 'portal',
      createdBy: 'avery@example.com',
      canManage: true,
      pendingApprovalId: null,
      delivery: [
        { type: 'file', format: 'xlsx', retain: 26 },
        { type: 'email', key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients', format: 'xlsx' },
        { type: 'teams', key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' },
      ],
    });
    // Key names only: no configured value (addresses, webhook URL) is ever in a response.
    expect(res.body).not.toContain('webhook.office.com');
    expect(res.body).not.toContain('it-reports@');

    const row = (await t.schedules.store.getSchedule(item.key))!;
    expect(row).toMatchObject({ source: 'portal', enabled: true, createdBy: AVERY.oid });
    expect(row.nextRunAt!.toISOString()).toBe('2026-10-19T05:00:00.000Z');
    // The stored definition is a valid schedule built like the editor's YAML, with delivery as ${ env.KEY }.
    const def = Schedule.parse(row.definition);
    expect(def).toMatchObject({
      kind: 'schedule',
      id: item.key,
      version: '1.0.0',
      owner: 'avery@example.com',
      tags: ['identity', 'users', 'report', 'portal'],
      identity: 'automation',
      overlap: 'skip',
      retry: { max: 2, backoff: 'exponential', delay: '5m' },
      job: {
        kind: 'report',
        ref: 'identity.inactive-users',
        params: { days: 90, includeGuests: true },
        delivery: [
          { type: 'file', format: 'xlsx', retain: 26 },
          { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'], format: 'xlsx' },
          { type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' },
        ],
      },
      // Files stay restricted to Operators plus the report's roles, even after the report is retired.
      requires: {
        scopes: { graph: ['User.Read.All', 'AuditLog.Read.All'] },
        licences: ['AAD_PREMIUM'],
        portalRoles: ['Portal.Operator', 'Portal.Reader'],
      },
    });
    expect(row.sha256).toBe(createHash('sha256').update(canonical(def)).digest('hex'));

    expect(events).toEqual(expect.arrayContaining(['schedules.changed', 'schedule.updated']));
    const audit = t.audit.rows.find((r) => r.action === 'schedule.created')!;
    expect(audit).toMatchObject({
      actorUpn: 'avery@example.com',
      actorOid: AVERY.oid,
      targetType: 'schedule',
      targetId: item.key,
      result: 'success',
      details: {
        report: 'identity.inactive-users',
        reportVersion: '1.2.0',
        version: '1.0.0',
        sha256: row.sha256,
        cron: '0 6 * * 1',
        timezone: 'Europe/London',
        enabled: true,
        format: 'xlsx',
        retain: 26,
        params: { days: 90, includeGuests: true },
        emailKey: 'AF_REPORT_RECIPIENTS',
        teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK',
        notifyOnFailure: { emailKey: null, teamsKey: null },
      },
    });

    // The list and GET /:key include it; another Operator sees it but can't manage it.
    const other = await t.login(BLAKE, OPERATOR);
    expect((await other.get(`/api/schedules/${item.key}`)).json()).toMatchObject({
      key: item.key,
      canManage: false,
    });
    expect(
      (await other.get('/api/schedules')).json().items.find((i: { key: string }) => i.key === item.key),
    ).toMatchObject({ source: 'portal', createdBy: 'avery@example.com', canManage: false });
    await t.close();
  });

  it('starts disabled when asked, with failure alerts and a JSON file', async () => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', {
      ...body({
        enabled: false,
        notifyOnFailure: { emailKey: 'AF_SECURITY_ALERTS', teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK' },
      }),
      job: { kind: 'report', ref: 'identity.inactive-users', format: 'json', retain: 4 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      enabled: false,
      nextRunAt: null,
      delivery: [{ type: 'file', format: 'json', retain: 4 }],
      notify: [
        { type: 'email', key: 'AF_SECURITY_ALERTS', label: 'Security alerts' },
        { type: 'teams', key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' },
      ],
    });
    const row = (await t.schedules.store.getSchedule(res.json().key))!;
    expect(row).toMatchObject({ enabled: false, nextRunAt: null });
    expect(row.definition.notify).toEqual({
      onFailure: [
        { type: 'email', to: ['${ env.AF_SECURITY_ALERTS }'] },
        { type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' },
      ],
    });
    await t.close();
  });

  it('the scheduler picks a new schedule up and runs its report job when due', async () => {
    const jobs = new FakeJobs(() => ({ result: { report: 'identity.inactive-users' } }));
    const t = await portalApp({ jobs, inProcess: true });
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', body({ cron: '0 * * * *', timezone: 'UTC' }));
    expect(res.statusCode).toBe(201);
    expect(res.json().nextRunAt).toBe('2026-10-15T13:00:00.000Z');
    await flush();
    await t.clock.advance(3_600_000);
    await t.schedules.scheduler!.drain();
    expect(jobs.calls).toHaveLength(1);
    expect(jobs.calls[0]!.schedule.key).toBe(res.json().key);
    expect(jobs.calls[0]!.def.job).toMatchObject({ kind: 'report', ref: 'identity.inactive-users' });
    // Audited as scheduled by the creator (UPN), executed as the automation identity.
    expect(jobs.calls[0]!.scheduledBy).toBe('avery@example.com');
    await t.close();
  });

  it('is allowed while automation is paused (the scheduler skips its runs)', async () => {
    const t = await portalApp();
    const admin = await t.login(DANA, ALL_ROLES);
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/admin/emergency',
          headers: admin.headers,
          payload: { target: 'automation', paused: true, reason: 'Investigating a schedule' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await admin.post('/api/schedules', body())).statusCode).toBe(201);
    await t.close();
  });

  it('needs Portal.Operator (a Reader is refused; delivery options too)', async () => {
    const t = await portalApp();
    const reader = await t.login(READER, ['Portal.Reader']);
    const res = await reader.post('/api/schedules', body());
    expect(res.statusCode).toBe(403);
    expect(error(res)).toMatchObject({
      code: 'forbidden',
      message: 'Scheduling reports needs the Portal.Operator role.',
    });
    expect((await reader.get('/api/schedules/delivery-options')).statusCode).toBe(403);
    expect(await t.schedules.store.listSchedules()).toHaveLength(0);
    expect(t.audit.rows.some((r) => r.action === 'schedule.created')).toBe(false);
    await t.close();
  });

  it('offers configured recipient lists and webhooks by name, never their values', async () => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.get('/api/schedules/delivery-options');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: {
        available: true,
        lists: [
          { key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients' },
          { key: 'AF_SECURITY_ALERTS', label: 'Security alerts' },
        ],
      },
      teams: { lists: [{ key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' }] },
    });
    expect(res.body).not.toContain('@example.com');
    await t.close();
    // Without a sender mailbox, email isn't available (lists are still named, the form explains).
    const noMail = await portalApp({ env: { AF_REPORT_RECIPIENTS: 'it-reports@example.com' } });
    const op2 = await noMail.login(AVERY, OPERATOR);
    expect((await op2.get('/api/schedules/delivery-options')).json()).toEqual({
      email: { available: false, lists: [{ key: 'AF_REPORT_RECIPIENTS', label: 'Report recipients' }] },
      teams: { lists: [] },
    });
    await noMail.close();
  });
});

describe('POST /api/schedules refusals', () => {
  const cases: Array<[string, Record<string, unknown>, number, string, RegExp?]> = [
    [
      'a probe job',
      { job: { kind: 'probe', tags: ['x'] } },
      400,
      'job_not_allowed',
      /Schedules → New schedule/,
    ],
    ['a playbook job', { job: { kind: 'playbook', ref: 'identity.disable-user' } }, 400, 'job_not_allowed'],
    ['a missing title', { title: '' }, 400, 'invalid_request'],
    [
      'an unknown report',
      { job: { kind: 'report', ref: 'identity.nope', format: 'xlsx' } },
      404,
      'definition_not_found',
    ],
    [
      'a draft report',
      { job: { kind: 'report', ref: 'identity.draft-report', format: 'xlsx' } },
      404,
      'definition_not_found',
    ],
    [
      'a report without export',
      { job: { kind: 'report', ref: 'security.no-export', format: 'xlsx' } },
      400,
      'export_not_supported',
    ],
    [
      'a format the report does not export',
      { job: { kind: 'report', ref: 'azure.monthly-cost', format: 'csv' } },
      400,
      'format_not_supported',
    ],
    [
      'an unknown param',
      { job: { kind: 'report', ref: 'identity.inactive-users', format: 'xlsx', params: { nope: 1 } } },
      400,
      'invalid_params',
    ],
    [
      'a param value the report refuses',
      { job: { kind: 'report', ref: 'identity.inactive-users', format: 'xlsx', params: { days: 45 } } },
      400,
      'invalid_params',
    ],
    ['an invalid cron', { cron: '61 * * * *' }, 400, 'invalid_cron', /five fields/],
    ['every 15 minutes', { cron: '*/15 * * * *' }, 400, 'cron_too_frequent'],
    ['twice within an hour', { cron: '0,30 6 * * 1' }, 400, 'cron_too_frequent'],
    ['every minute in December only', { cron: '* * * 12 *' }, 400, 'cron_too_frequent'],
    [
      'an unconfigured recipient list',
      {
        job: {
          kind: 'report',
          ref: 'identity.inactive-users',
          format: 'xlsx',
          emailKey: 'AF_EMPTY_RECIPIENTS',
        },
      },
      400,
      'delivery_not_configured',
      /AF_EMPTY_RECIPIENTS/,
    ],
    [
      'a key that is not a recipient list',
      { job: { kind: 'report', ref: 'identity.inactive-users', format: 'xlsx', emailKey: 'AF_MAIL_SENDER' } },
      400,
      'delivery_not_configured',
    ],
    [
      'a recipient list used as a webhook',
      {
        job: {
          kind: 'report',
          ref: 'identity.inactive-users',
          format: 'xlsx',
          teamsKey: 'AF_REPORT_RECIPIENTS',
        },
      },
      400,
      'delivery_not_configured',
    ],
    [
      'an unconfigured failure alert',
      { notifyOnFailure: { teamsKey: 'AF_OPS_WEBHOOK' } },
      400,
      'delivery_not_configured',
    ],
    ['a non-configuration key', { notifyOnFailure: { emailKey: 'DATABASE_URL' } }, 400, 'invalid_request'],
  ];

  it.each(cases)('refuses %s', async (_label, over, status, code, hint) => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', body(over));
    expect(res.statusCode).toBe(status);
    const e = error(res);
    expect(e.code).toBe(code);
    expect(e.message).toBeTruthy();
    if (code !== 'invalid_request') expect(e.hint).toBeTruthy();
    if (hint) expect(`${e.message} ${e.hint}`).toMatch(hint);
    // Nothing was created (the content schedule may have been synced while reading content).
    expect((await t.schedules.store.listSchedules()).filter((r) => r.source === 'portal')).toEqual([]);
    expect(t.audit.rows.some((r) => r.action === 'schedule.created')).toBe(false);
    await t.close();
  });

  it('cron_too_frequent says why', async () => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    const e = error(await op.post('/api/schedules', body({ cron: '*/30 * * * *' })));
    expect(e).toMatchObject({ code: 'cron_too_frequent', message: 'Reports can run at most once an hour.' });
    // Hourly is fine.
    expect((await op.post('/api/schedules', body({ cron: '15 * * * *' }))).statusCode).toBe(201);
    await t.close();
  });

  it('email needs the sender mailbox configured', async () => {
    const t = await portalApp({ env: { AF_REPORT_RECIPIENTS: 'it-reports@example.com' } });
    const op = await t.login(AVERY, OPERATOR);
    const e = error(await op.post('/api/schedules', body({}, { emailKey: 'AF_REPORT_RECIPIENTS' })));
    expect(e).toMatchObject({
      code: 'delivery_not_configured',
      hint: expect.stringContaining('AF_MAIL_SENDER'),
    });
    await t.close();
  });

  it('needs every role the report requires', async () => {
    const t = await portalApp();
    // An Operator-only report: an Operator may schedule it …
    const op = await t.login(AVERY, OPERATOR);
    expect(
      (await op.post('/api/schedules', body({}, { ref: 'azure.monthly-cost', format: 'xlsx' }))).statusCode,
    ).toBe(201);
    await t.close();
    // … a report needing Portal.Admin is refused to an Operator who isn't one.
    const adminOnly = { ...inactiveUsers, requires: { portalRoles: ['Portal.Admin'] } };
    const defs = reportDefs().set(adminOnly as never);
    const t2 = await portalApp({ defs });
    const op2 = await t2.login(AVERY, OPERATOR);
    const res = await op2.post('/api/schedules', body());
    expect(res.statusCode).toBe(403);
    // The refusal doesn't name the report (the caller may not be allowed to see it).
    expect(error(res)).toMatchObject({
      code: 'forbidden',
      message: 'Scheduling this report needs the Portal.Admin role.',
    });
    expect(res.body).not.toContain('Inactive users');
    await t2.close();
  });

  it('caps portal schedules at 25 per person and 200 in total (deleted ones do not count)', async () => {
    const t = await portalApp();
    const avery = await t.login(AVERY, OPERATOR);
    const blake = await t.login(BLAKE, OPERATOR);
    const seed = async (n: number, createdBy: string, status?: 'retired') => {
      const def = Schedule.parse({
        kind: 'schedule',
        id: 'portal.seed-0',
        version: '1.0.0',
        title: 'Seed',
        owner: 'seed@example.com',
        cron: '0 6 * * 1',
        job: { kind: 'report', ref: 'identity.inactive-users', delivery: [{ type: 'file', format: 'xlsx' }] },
        ...(status ? { status } : {}),
      });
      for (let i = 0; i < n; i++)
        await t.schedules.store.insertSchedule({
          key: `portal.seed-${createdBy.slice(-4)}-${status ?? 'a'}-${i}`,
          source: 'portal',
          definition: { ...def, id: `portal.seed-${i}` },
          sha256: `sha-${i}`,
          enabled: false,
          nextRunAt: null,
          createdBy,
        });
    };
    await seed(24, AVERY.oid);
    await seed(5, AVERY.oid, 'retired');
    expect((await avery.post('/api/schedules', body())).statusCode).toBe(201);
    const mine = await avery.post('/api/schedules', body());
    expect(mine.statusCode).toBe(409);
    expect(error(mine)).toMatchObject({ code: 'schedule_limit', message: expect.stringContaining('25') });
    // Others can still create until the installation-wide cap.
    expect((await blake.post('/api/schedules', body())).statusCode).toBe(201);
    await seed(174, DANA.oid);
    const total = await blake.post('/api/schedules', body());
    expect(total.statusCode).toBe(409);
    expect(error(total)).toMatchObject({ code: 'schedule_limit', message: expect.stringContaining('200') });
    await t.close();
  });
});
