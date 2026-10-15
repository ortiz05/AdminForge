import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AVERY, FakeDefinitions, READER, schedule, schedulesApp } from './schedules-helpers';

// Report links are plain navigations: a failed download opens the explained problem page instead of saving the JSON
// error under the report's file name.
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const problem = (location: unknown) => new URL(String(location), 'https://portal.example.test');

async function setup() {
  const defs = new FakeDefinitions().set(
    schedule('reports.weekly', {
      cron: '0 7 * * 1',
      job: { kind: 'report', ref: 'azure.example', delivery: [{ type: 'file', format: 'csv' }] },
    }),
  );
  const t = await schedulesApp({ defs });
  const op = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
  await op.get('/api/schedules');
  const row = (await t.schedules.store.getSchedule('reports.weekly'))!;
  mkdirSync(path.join(t.artifactsDir, 'reports.weekly'), { recursive: true });
  writeFileSync(path.join(t.artifactsDir, 'reports.weekly', '2026-10-15T06-00-00Z.csv'), 'Name\r\n');
  const run = await t.schedules.store.insertRun({
    scheduleId: row.id,
    scheduleKey: row.key,
    trigger: 'cron',
    status: 'succeeded',
    artifactPath: 'reports.weekly/2026-10-15T06-00-00Z.csv',
  });
  return { t, op, run };
}

describe('report download failures in the browser', () => {
  it('a Reader without the schedule’s role is sent to the problem page (download context)', async () => {
    const { t, run } = await setup();
    const reader = await t.login(READER, ['Portal.Reader']);
    const res = await reader.get(`/api/artifacts/${run.id}`, NAVIGATE);
    expect(res.statusCode).toBe(303);
    const url = problem(res.headers.location);
    expect(url.pathname).toBe('/sign-in-problem');
    expect(url.searchParams.get('code')).toBe('forbidden');
    expect(url.searchParams.get('during')).toBe('download');
    await t.close();
  });

  it('a signed-out navigation is explained too', async () => {
    const { t, run } = await setup();
    const res = await t.app.inject({ method: 'GET', url: `/api/artifacts/${run.id}`, headers: NAVIGATE });
    expect(problem(res.headers.location).searchParams.get('code')).toBe('unauthenticated');
    await t.close();
  });

  it('the file itself still downloads as an attachment, and fetch callers still get JSON', async () => {
    const { t, op, run } = await setup();
    const ok = await op.get(`/api/artifacts/${run.id}`, NAVIGATE);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-disposition']).toMatch(/^attachment;/);
    const reader = await t.login(READER, ['Portal.Reader']);
    const json = await reader.get(`/api/artifacts/${run.id}`, { 'sec-fetch-mode': 'cors' });
    expect(json.statusCode).toBe(403);
    expect(json.json().error.code).toBe('forbidden');
    await t.close();
  });
});
