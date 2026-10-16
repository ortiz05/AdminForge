import { ApiErrorBody, Schedule } from '@adminforge/schemas';
import { flush } from '../unit/scheduler/helpers';
import { FakeJobs, schedule } from './schedules-helpers';
import {
  AVERY,
  BLAKE,
  DELIVERY_ENV,
  OPERATOR,
  READER,
  body,
  inactiveUsers,
  portalApp,
  reportDefs,
} from './portal-schedules-helpers';

// Security review follow-ups for report schedules created in the portal: plain-text names, no approval keys as
// destinations, only schedulable params, redacted params and report-gated details in schedule items, the 24-hour
// creation cap, and Run now throttling.

const error = (res: { json(): unknown }) => ApiErrorBody.parse(res.json()).error;

/** The fixtures plus a report with a redacted param and one with a query builder. */
function defs() {
  return reportDefs()
    .set({
      ...inactiveUsers,
      id: 'identity.cost-centre-users',
      title: 'Users by cost centre',
      params: { ...inactiveUsers.params, costCode: { type: 'string', label: 'Cost code', redact: true } },
    } as never)
    .set({
      ...inactiveUsers,
      id: 'identity.filtered-users',
      title: 'Filtered users',
      filters: {
        advanced: { dialect: 'odata', fields: [{ field: 'displayName', label: 'Name', type: 'string' }] },
      },
    } as never);
}

describe('portal schedule names and summaries are plain text', () => {
  it.each([
    ['a line break', { title: 'Weekly\nClick here' }],
    ['a bidi override', { title: 'Weekly ‮txt.exe' }],
    ['a zero-width space', { title: 'Week​ly' }],
    ['a link', { title: 'See https://example.com/x' }],
    ['www.', { title: 'See www.example.com' }],
    ['a Markdown link', { title: '[Open](mailto:x)' }],
    ['angle brackets', { title: 'Weekly <b>report</b>' }],
    ['a link in the summary', { summary: 'Details at http://example.com' }],
    ['a line break in the summary', { summary: 'One\ntwo' }],
  ])('refuses %s (invalid_request with a hint)', async (_label, over) => {
    const t = await portalApp({ defs: defs() });
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', body(over));
    expect(res.statusCode).toBe(400);
    const e = error(res);
    expect(e.code).toBe('invalid_request');
    expect(e.message).toMatch(/plain text|links or markup/);
    expect(e.hint).toBeTruthy();
    expect((await t.schedules.store.listSchedules()).filter((r) => r.source === 'portal')).toEqual([]);
    await t.close();
  });

  it('accepts ordinary names with punctuation', async () => {
    const t = await portalApp({ defs: defs() });
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post(
      '/api/schedules',
      body({
        title: 'Inactive users (90 days) – weekly, for IT_Ops & HR',
        summary: 'Sent to the identity team.',
      }),
    );
    expect(res.statusCode).toBe(201);
    await t.close();
  });
});

describe('approval keys are never report destinations', () => {
  const env = {
    ...DELIVERY_ENV,
    AF_APPROVALS_EMAIL: 'approvers@example.com',
    AF_APPROVALS_TEAMS_WEBHOOK: 'https://example.webhook.office.com/webhookb2/approvals',
  };

  it('delivery options leave them out', async () => {
    const t = await portalApp({ env });
    const op = await t.login(AVERY, OPERATOR);
    const options = (await op.get('/api/schedules/delivery-options')).json();
    const keys = [...options.email.lists, ...options.teams.lists].map((l: { key: string }) => l.key);
    expect(keys).not.toContain('AF_APPROVALS_EMAIL');
    expect(keys).not.toContain('AF_APPROVALS_TEAMS_WEBHOOK');
    await t.close();
  });

  it.each([
    [{ emailKey: 'AF_APPROVALS_EMAIL' }, {}],
    [{ teamsKey: 'AF_APPROVALS_TEAMS_WEBHOOK' }, {}],
    [{}, { notifyOnFailure: { emailKey: 'AF_APPROVALS_EMAIL' } }],
  ])('create refuses %j %j (delivery_not_configured)', async (job, over) => {
    const t = await portalApp({ env });
    const op = await t.login(AVERY, OPERATOR);
    const e = error(await op.post('/api/schedules', body(over, job)));
    expect(e).toMatchObject({
      code: 'delivery_not_configured',
      message: expect.stringContaining('approval'),
    });
    await t.close();
  });
});

describe('only params the schedule form offers', () => {
  it.each([
    ['an entity picker', 'identity.inactive-users', { manager: '00000000-0000-4000-8000-0000000000a1' }],
    ['a date', 'identity.inactive-users', { since: '-7d' }],
    ['a hidden param', 'identity.inactive-users', { id: 'x' }],
    ['the query builder filter', 'identity.filtered-users', { adv: { all: [] } }],
  ])('refuses %s with "uses the report’s default"', async (_label, ref, params) => {
    const t = await portalApp({ defs: defs() });
    const op = await t.login(AVERY, OPERATOR);
    const res = await op.post('/api/schedules', body({}, { ref, params }));
    expect(res.statusCode).toBe(400);
    const e = error(res);
    expect(e.code).toBe('invalid_params');
    expect(e.message).toContain(Object.keys(params)[0]!);
    expect(e.hint).toMatch(/report’s default/);
    await t.close();
  });
});

describe('schedule items: redacted params and report-gated details', () => {
  it('masks redact: true params, and keeps the stored value when the mask comes back on PUT', async () => {
    const t = await portalApp({ defs: defs() });
    const op = await t.login(AVERY, OPERATOR);
    const created = await op.post(
      '/api/schedules',
      body({}, { ref: 'identity.cost-centre-users', params: { costCode: 'CC-1234', days: 30 } }),
    );
    expect(created.statusCode).toBe(201);
    const key = created.json().key as string;
    expect(created.json().job.params).toEqual({ costCode: '[redacted]', days: 30 });
    expect((await op.get(`/api/schedules/${key}`)).json().job.params).toEqual({
      costCode: '[redacted]',
      days: 30,
    });
    expect(created.body).not.toContain('CC-1234');
    // Audit masks it too.
    expect(JSON.stringify(t.audit.rows.find((r) => r.action === 'schedule.created')!.details)).not.toContain(
      'CC-1234',
    );
    // Editing with the masked value (what the form got) keeps the stored one.
    const saved = await op.put(
      `/api/schedules/${key}`,
      body(
        { title: 'Renamed' },
        { ref: 'identity.cost-centre-users', params: { costCode: '[redacted]', days: 90 } },
      ),
    );
    expect(saved.statusCode).toBe(200);
    const def = (await t.schedules.store.getSchedule(key))!.definition as Schedule;
    expect(def.job).toMatchObject({ params: { costCode: 'CC-1234', days: 90 } });
    await t.close();
  });

  it('omits params, delivery and alerts of schedules whose report the caller can’t open', async () => {
    const t = await portalApp({ defs: defs() });
    const op = await t.login(AVERY, OPERATOR);
    const created = await op.post(
      '/api/schedules',
      body(
        { notifyOnFailure: { teamsKey: 'AF_TEAMS_ALERTS_WEBHOOK' } },
        { ref: 'azure.monthly-cost', emailKey: 'AF_REPORT_RECIPIENTS' },
      ),
    );
    expect(created.statusCode).toBe(201);
    const key = created.json().key as string;
    expect(created.json()).toHaveProperty('delivery');
    // A Reader may list schedules but can't open the Operator-only report.
    const reader = await t.login(READER, ['Portal.Reader']);
    const seen = (await reader.get(`/api/schedules/${key}`)).json();
    expect(seen).toMatchObject({ key, job: { kind: 'report', ref: 'azure.monthly-cost' } });
    expect(seen.job).not.toHaveProperty('params');
    expect(seen).not.toHaveProperty('delivery');
    expect(seen).not.toHaveProperty('notify');
    const listed = (await reader.get('/api/schedules'))
      .json()
      .items.find((i: { key: string }) => i.key === key);
    expect(listed).not.toHaveProperty('delivery');
    // The Operator still sees them.
    expect((await op.get(`/api/schedules/${key}`)).json()).toMatchObject({
      delivery: expect.any(Array),
      notify: [{ type: 'teams', key: 'AF_TEAMS_ALERTS_WEBHOOK', label: 'Teams alerts' }],
    });
    await t.close();
  });
});

describe('creation caps', () => {
  it('50 created per person in 24 hours, deleted ones included; then a day later it works again', async () => {
    const t = await portalApp();
    const op = await t.login(AVERY, OPERATOR);
    // 49 earlier today (all deleted) and one active.
    for (let i = 0; i < 49; i++)
      await t.schedules.store.insertSchedule({
        key: `portal.seed-${i}`,
        source: 'portal',
        definition: Schedule.parse({
          kind: 'schedule',
          id: `portal.seed-${i}`,
          version: '1.0.0',
          title: 'Seed',
          owner: 'avery@example.com',
          cron: '0 6 * * 1',
          status: 'retired',
          job: {
            kind: 'report',
            ref: 'identity.inactive-users',
            delivery: [{ type: 'file', format: 'xlsx' }],
          },
        }),
        sha256: `sha-${i}`,
        enabled: false,
        nextRunAt: null,
        createdBy: AVERY.oid,
      });
    expect((await op.post('/api/schedules', body())).statusCode).toBe(201);
    const capped = await op.post('/api/schedules', body());
    expect(capped.statusCode).toBe(409);
    expect(error(capped)).toMatchObject({
      code: 'schedule_limit',
      message: expect.stringContaining('24 hours'),
    });
    // Someone else isn't affected.
    const other = await t.login(BLAKE, OPERATOR);
    expect((await other.post('/api/schedules', body())).statusCode).toBe(201);
    await t.clock.advance(86_400_000 + 1);
    const later = await t.login(AVERY, OPERATOR); // (the earlier session has expired by now)
    expect((await later.post('/api/schedules', body())).statusCode).toBe(201);
    await t.close();
  });
});

describe('Run now on a portal schedule', () => {
  it('refuses while a run waits or runs, and within 15 minutes of the last manual run (429 run_too_soon)', async () => {
    const jobs = new FakeJobs();
    const t = await portalApp({ jobs, inProcess: true });
    const op = await t.login(AVERY, OPERATOR);
    const key = (await op.post('/api/schedules', body())).json().key as string;
    jobs.manual = true;
    expect((await op.post(`/api/schedules/${key}/run`)).statusCode).toBe(202);
    const busy = await op.post(`/api/schedules/${key}/run`);
    expect(busy.statusCode).toBe(429);
    expect(error(busy)).toMatchObject({
      code: 'run_too_soon',
      message: 'This schedule is already running or waiting to run.',
      hint: expect.any(String),
    });
    await flush();
    await t.clock.advance(1);
    jobs.finish();
    await t.schedules.scheduler!.drain();
    await t.clock.advance(5 * 60_000);
    const soon = await op.post(`/api/schedules/${key}/run`);
    expect(soon.statusCode).toBe(429);
    expect(error(soon)).toMatchObject({ code: 'run_too_soon', hint: expect.stringMatching(/10 minutes/) });
    await t.clock.advance(10 * 60_000);
    expect((await op.post(`/api/schedules/${key}/run`)).statusCode).toBe(202);
    await t.close();
  });

  it('content schedules are unchanged (Run now twice is fine)', async () => {
    const t = await portalApp({ defs: reportDefs().set(schedule('sweep.hourly', { cron: '0 * * * *' })) });
    const op = await t.login(AVERY, OPERATOR);
    expect((await op.post('/api/schedules/sweep.hourly/run')).statusCode).toBe(202);
    expect((await op.post('/api/schedules/sweep.hourly/run')).statusCode).toBe(202);
    await t.close();
  });
});
