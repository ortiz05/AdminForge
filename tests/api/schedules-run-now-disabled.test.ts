import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { DatasourceRunner } from '@adminforge/api/src/datasources/executor';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import { AppError } from '@adminforge/api/src/errors';
import type { ServiceCall } from '@adminforge/api/src/execution/types';
import { createJobRunner, FILE_ONLY_NOTE, type JobContext } from '@adminforge/api/src/schedules/jobs';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { Report } from '@adminforge/schemas';
import { AVERY, FakeDefinitions, FakeJobs, FakeOutbound, schedule, schedulesApp } from './schedules-helpers';

// F-10 (decision: Run now on a switched-off schedule writes the file only — no email, Teams or notifications — and
// says so). It is how an owner tries a schedule before turning it on; until now it also mailed its recipients
// (e.g. billing.month-close → finance) whatever `enabled` said.
const HOOK = 'https://example.webhook.office.com/webhookb2/alerts';
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];

async function setup(opts: { enabled: boolean; fail?: boolean }) {
  const posts: string[] = [];
  const defs = new FakeDefinitions().set(
    schedule('reports.month-close', {
      cron: '0 8 1 * *',
      enabled: opts.enabled,
      job: { kind: 'probe', ref: 'probes.example' },
      notify: {
        onSuccess: [{ type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' }],
        onFailure: [{ type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' }],
      },
    }),
  );
  const jobs = new FakeJobs(() => {
    if (opts.fail) throw new AppError(502, 'upstream_error', 'Microsoft Graph answered 502.');
    return { result: { ok: true } };
  });
  const t = await schedulesApp({
    defs,
    jobs,
    inProcess: true,
    schedules: {
      delivery: {
        fetch: (async (_url: string, init: RequestInit) => {
          posts.push(String(init.body));
          return new Response('', { status: 202 });
        }) as never,
        env: { AF_TEAMS_ALERTS_WEBHOOK: HOOK },
        publicBaseUrl: 'https://portal.example.com',
      },
    },
  });
  const op = await t.login(AVERY, OPERATOR);
  const run = async () => {
    const res = await op.post('/api/schedules/reports.month-close/run');
    await t.clock.advance(1);
    await t.schedules.scheduler!.drain();
    return res;
  };
  return { t, op, jobs, posts, run };
}

describe('Run now on a switched-off schedule', () => {
  it('runs the job, sends nothing, and says so in the answer, the history and the audit', async () => {
    const { t, op, jobs, posts, run } = await setup({ enabled: false });
    const res = await run();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      scheduleRunId: expect.any(String),
      fileOnly: true,
      message:
        'The schedule is switched off, so this run writes the file only: nothing is emailed, posted to Teams or notified.',
    });
    expect(jobs.calls).toHaveLength(1);
    expect(jobs.calls[0]!.fileOnly).toBe(true);
    // notify.onSuccess stays quiet while the schedule is off.
    expect(posts).toEqual([]);
    expect(t.audit.rows.find((r) => r.action === 'schedule.notified')).toBeUndefined();

    const [item] = (await op.get('/api/schedules/reports.month-close/runs')).json().items;
    expect(item).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      reason: 'The schedule was off, so this run sent no email, Teams message or notification.',
    });
    expect(t.audit.rows.find((r) => r.action === 'schedule.run_requested')!.details).toMatchObject({
      fileOnly: true,
    });
    await t.close();
  });

  it('while it waits, the history says so in the present', async () => {
    const { t, op } = await setup({ enabled: false });
    expect((await op.post('/api/schedules/reports.month-close/run')).statusCode).toBe(202);
    const [item] = (await op.get('/api/schedules/reports.month-close/runs')).json().items;
    expect(item).toMatchObject({
      status: 'queued',
      reason: 'The schedule is off, so this run sends no email, Teams message or notification.',
    });
    await t.close();
  });

  it('a failure tells no one either (the person who ran it sees it in the history)', async () => {
    const { t, op, posts, run } = await setup({ enabled: false, fail: true });
    await run();
    expect(posts).toEqual([]);
    const [item] = (await op.get('/api/schedules/reports.month-close/runs')).json().items;
    expect(item).toMatchObject({ status: 'failed', error: { code: 'upstream_error' } });
    expect(t.audit.rows.find((r) => r.action === 'schedule.failed')!.details).toMatchObject({
      notify: [],
      fileOnly: true,
    });
    await t.close();
  });

  it('a schedule that is on delivers as before', async () => {
    const { t, op, jobs, posts, run } = await setup({ enabled: true });
    const res = await run();
    expect(res.json()).toEqual({ scheduleRunId: expect.any(String) });
    expect(jobs.calls[0]!.fileOnly).toBeUndefined();
    expect(posts).toHaveLength(1);
    const [item] = (await op.get('/api/schedules/reports.month-close/runs')).json().items;
    expect(item.reason).toBeUndefined();
    await t.close();
  });
});

describe('a file-only report run', () => {
  const NOW = new Date('2026-10-15T06:00:00.000Z');
  const REPORT = Report.parse({
    kind: 'report',
    id: 'billing.example-month',
    version: '1.0.0',
    title: 'Month close',
    owner: 'finance-team',
    datasources: { rows: { source: 'resourceGraph', query: 'resources | take 5', paging: 'all' } },
    layout: [{ widget: 'table', data: 'rows.value', columns: [{ field: 'name', label: 'Name' }] }],
    export: { formats: ['csv', 'xlsx'], data: 'rows.value', columns: 'all' },
  });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-file-only-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function ctxFor(fileOnly: boolean): JobContext {
    const def = schedule('billing.month-close', {
      job: {
        kind: 'report',
        ref: 'billing.example-month',
        delivery: [
          { type: 'file', format: 'csv' },
          { type: 'email', to: ['${ env.AF_FINANCE_RECIPIENTS }'], format: 'csv' },
          { type: 'teams', webhook: '${ env.AF_TEAMS_FINANCE_WEBHOOK }' },
        ],
      },
    });
    return {
      schedule: { id: 's1', key: def.id, source: 'content', definition: def, enabled: false } as ScheduleRow,
      def,
      run: { id: 'r1', scheduleId: 's1', scheduleKey: def.id, trigger: 'manual' } as ScheduleRunRow,
      signal: new AbortController().signal,
      correlationId: 'c1',
      scheduledBy: null,
      ...(fileOnly ? { fileOnly: true } : {}),
    };
  }

  function runner() {
    const registry = registryFrom(new FakeDefinitions().set(REPORT as never) as never, 'fs');
    const outbound = new FakeOutbound(() => ({ value: [{ name: 'sub-1' }], totalRecords: 1 }));
    const mail: ServiceCall[] = [];
    const posts: string[] = [];
    const jobs = createJobRunner({
      definitions: registry,
      store: new MemoryScheduleStore(() => NOW),
      outbound,
      probes: {
        automation: null,
        connection: async () => Promise.reject(new Error('none')),
        env: () => ({}),
        now: () => NOW,
        fetch: async () => new Response(''),
      },
      datasources: new DatasourceRunner({ definitions: registry, outbound, env: () => ({}), now: () => NOW }),
      artifacts: new ArtifactStore(dir),
      runs: null,
      automationClientId: null,
      exportMaxRows: 1000,
      now: () => NOW,
      delivery: {
        outbound: {
          execute: async (_i: unknown, call: ServiceCall) => {
            mail.push(call);
            return { data: null, status: 202, provenance: { service: 'graph', path: '/x', ms: 1 } };
          },
        } as never,
        fetch: (async (_url: string, init: RequestInit) => {
          posts.push(String(init.body));
          return new Response('', { status: 202 });
        }) as never,
        env: {
          AF_MAIL_SENDER: 'reports@example.com',
          AF_FINANCE_RECIPIENTS: 'finance@example.com',
          AF_TEAMS_FINANCE_WEBHOOK: 'https://example.webhook.office.com/webhookb2/finance',
        },
        publicBaseUrl: 'https://portal.example.com',
      },
    });
    return { jobs, mail, posts };
  }

  it('writes the file and sends neither the email nor the Teams post, noting why', async () => {
    const { jobs, mail, posts } = runner();
    const r = await jobs.run(ctxFor(true));
    expect(r.artifactPath).toMatch(/^billing\.month-close\//);
    expect(mail).toEqual([]);
    expect(posts).toEqual([]);
    expect(r.result).toMatchObject({
      delivery: [
        { type: 'email', status: 'skipped', message: FILE_ONLY_NOTE },
        { type: 'teams', status: 'skipped', message: FILE_ONLY_NOTE },
      ],
    });
  });

  it('delivers both when it is not file-only (control)', async () => {
    const { jobs, mail, posts } = runner();
    const r = await jobs.run(ctxFor(false));
    expect(mail).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(r.result).toMatchObject({ delivery: [{ status: 'sent' }, { status: 'sent' }] });
  });
});
