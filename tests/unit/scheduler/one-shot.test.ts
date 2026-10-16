import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '@adminforge/api/src/errors';
import { loadConfig } from '@adminforge/api/src/config';
import type { ProbeOutcome } from '@adminforge/api/src/probes/checks';
import {
  openOneShot,
  PROBE_HEADER,
  probeFailed,
  probeLine,
  probeSummary,
  runProbesOnce,
  runScheduleOnce,
  scheduleRunLines,
  type ProbesOnceDeps,
} from '@adminforge/scheduler/one-shot';
import { FakeDefinitions, FakeJobs, harness, probe, schedule } from './helpers';

// The scheduler's one-shot module (portal/apps/scheduler/src/one-shot.ts), shared by `adminforge-scheduler --schedule
// / --probe / --once` and tests/live/scripts/run-schedule-once.ts: status lines print statuses, codes and counts only.

const NOW = new Date('2026-10-15T12:00:00Z');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function outcome(key: string, over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    probeKey: key,
    ts: NOW,
    status: 'ok',
    metric: 12.345,
    unit: 'ms',
    durationMs: 40,
    message: 'Reached graph.microsoft.com as admin@contoso.onmicrosoft.com',
    code: 'ok',
    details: null,
    ...over,
  };
}

describe('scheduleRunLines', () => {
  it('prints status, counts and the error code, then files, deliveries, probe results and a playbook run', () => {
    const lines = scheduleRunLines('reports.weekly', {
      status: 'failed',
      error: { code: 'report_incomplete', message: 'Datasource users failed for avery@example.com' },
      result: {
        probes: 2,
        ok: 1,
        crit: 1,
        ignored: 'text',
        artifacts: [{ format: 'xlsx', rows: 120, truncated: true, path: 'reports/weekly.xlsx' }],
        delivery: [{ type: 'email', status: 'sent', message: 'Sent to it-reports@example.com' }],
        results: [
          { key: 'probes.a', status: 'ok', code: 'ok', message: 'secret detail' },
          { key: 'feeds.b', status: 'ok', code: 'ok', new: 3 },
        ],
        runStatus: 'queued',
        dryRun: true,
      },
    });
    expect(lines[0]).toBe('reports.weekly: failed (probes=2 ok=1 crit=1) — report_incomplete');
    expect(lines).toContain('  file xlsx: 120 row(s) (truncated)');
    expect(lines).toContain('  delivery email: sent');
    expect(lines.find((l) => l.includes('probes.a'))).toMatch(/^ {2}probes\.a\s+ok\s+ok\s*$/);
    expect(lines.find((l) => l.includes('feeds.b'))).toMatch(/new=3 updated=0$/);
    expect(lines.at(-1)).toBe('  playbook run (run worker): queued (dry run)');
    // Messages, recipients and paths never reach the output.
    expect(lines.join('\n')).not.toMatch(/example\.com|secret|weekly\.xlsx|Datasource/);
  });

  it('is one line for a plain success, and tolerates a run without a result', () => {
    expect(scheduleRunLines('probes.sweep', { status: 'succeeded', error: null, result: null })).toEqual([
      'probes.sweep: succeeded',
    ]);
  });
});

describe('probe lines', () => {
  it('lines up under the header with key, kind, status, code, metric and duration — never the message', () => {
    const line = probeLine({ kind: 'graph', outcome: outcome('probes.reach') });
    expect(line.indexOf('graph')).toBe(PROBE_HEADER.indexOf('kind'));
    expect(line).toMatch(/^probes\.reach\s+graph\s+ok\s+ok\s+12\.3 ms\s+40 ms$/);
    expect(line).not.toMatch(/contoso|admin@/);
    expect(probeLine({ kind: 'kql', outcome: outcome('probes.kql', { metric: null }) })).toMatch(
      /\s-\s+40 ms$/,
    );
  });

  it('summarises the counts and flags crit and error as failures', () => {
    expect(probeSummary({ results: [{}, {}] as never, counts: { ok: 1, warn: 0, crit: 1, error: 0 } })).toBe(
      '2 probes: ok=1 warn=0 crit=1 error=0',
    );
    expect(['ok', 'warn', 'crit', 'error'].map((status) => probeFailed({ status } as ProbeOutcome))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('runProbesOnce', () => {
  function setup(store: ProbesOnceDeps['store'] = null) {
    const defs = new FakeDefinitions()
      .set(probe('probes.b', { check: { kind: 'auditChain' } }))
      .set(probe('probes.a'))
      .set(schedule('schedules.not-a-probe'));
    const ran: string[] = [];
    const warnings: string[] = [];
    const deps: ProbesOnceDeps = {
      definitions: defs,
      probeDeps: {} as ProbesOnceDeps['probeDeps'],
      store,
      log: { warn: (_obj, msg) => warnings.push(msg) },
      run: async (key) => {
        ran.push(key);
        return outcome(key, key === 'probes.b' ? { status: 'crit', code: 'threshold' } : {});
      },
    };
    return { deps, ran, warnings };
  }

  it('runs every published probe in key order and counts the outcomes', async () => {
    const { deps, ran } = setup();
    const r = await runProbesOnce(deps);
    expect(ran).toEqual(['probes.a', 'probes.b']);
    expect(r.results.map((x) => [x.key, x.kind, x.outcome.status])).toEqual([
      ['probes.a', 'graph', 'ok'],
      ['probes.b', 'auditChain', 'crit'],
    ]);
    expect(r.counts).toEqual({ ok: 1, warn: 0, crit: 1, error: 0 });
    expect(r.missing).toEqual([]);
  });

  it('runs only the named probes and reports unknown keys instead of running them', async () => {
    const { deps, ran } = setup();
    const r = await runProbesOnce(deps, ['probes.b', 'probes.nope', 'probes.nope']);
    expect(ran).toEqual(['probes.b']);
    expect(r.missing).toEqual(['probes.nope']);
  });

  it('stores each result (message capped) and goes on when storing fails', async () => {
    const stored: unknown[] = [];
    const { deps, warnings } = setup({
      insertProbeResult: async (row) => {
        if (row.probeKey === 'probes.a') throw new Error('database is read-only');
        stored.push(row);
      },
    });
    const r = await runProbesOnce(deps);
    expect(r.results).toHaveLength(2);
    expect(stored).toEqual([
      expect.objectContaining({ probeKey: 'probes.b', status: 'crit', scheduleRunId: null, metric: 12.345 }),
    ]);
    expect(warnings).toEqual(['could not store the probe result']);
  });
});

describe('runScheduleOnce', () => {
  const HOOK = 'https://example.webhook.office.com/webhookb2/alerts';
  const deps = (
    h: ReturnType<typeof harness>,
    delivery?: Parameters<typeof runScheduleOnce>[0]['delivery'],
  ) => ({
    ctx: { definitions: h.defs, audit: h.audit, now: h.clock.now },
    schedules: { store: h.store, jobs: h.jobs, events: h.events },
    log: silent,
    ...(delivery ? { delivery } : {}),
  });

  it('runs the schedule now as a manual, audited run for whoever asked', async () => {
    const h = harness();
    h.defs.set(schedule('sweep.a', { enabled: false }));
    const run = await runScheduleOnce(deps(h), 'sweep.a', 'cli:operator');
    expect(run).toMatchObject({ scheduleKey: 'sweep.a', trigger: 'manual', status: 'succeeded' });
    expect(h.jobs.calls).toHaveLength(1);
    expect(h.audit.rows.find((r) => r.action === 'schedule.run')).toMatchObject({
      targetId: 'sweep.a',
      result: 'success',
    });
  });

  it('refuses an unknown schedule', async () => {
    await expect(runScheduleOnce(deps(harness()), 'sweep.nope', 'cli:operator')).rejects.toMatchObject({
      code: 'schedule_not_found',
    });
  });

  it('sends failure notifications only through a delivery override', async () => {
    const failing = () =>
      new FakeJobs(() => {
        throw new AppError(502, 'upstream_error', 'Microsoft Graph answered 502.');
      });
    const notified = schedule('sweep.a', {
      enabled: false,
      notify: { onFailure: [{ type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' }] },
    });
    const posts: string[] = [];
    const delivery = {
      outbound: {} as never,
      fetch: (async (url: string) => {
        posts.push(url);
        return new Response('', { status: 202 });
      }) as never,
      env: { AF_TEAMS_ALERTS_WEBHOOK: HOOK },
      publicBaseUrl: 'https://portal.example.com',
    };

    const quiet = harness({ jobs: failing() });
    quiet.defs.set(notified);
    expect((await runScheduleOnce(deps(quiet), 'sweep.a', 'cli:operator')).status).toBe('failed');
    expect(posts).toEqual([]);

    const told = harness({ jobs: failing() });
    told.defs.set(notified);
    await runScheduleOnce(deps(told, delivery), 'sweep.a', 'live-script:operator');
    expect(posts).toEqual([HOOK]);
  });
});

describe('openOneShot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-one-shot-'));
    const write = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, 'content', rel)), { recursive: true });
      writeFileSync(path.join(dir, 'content', rel), text);
    };
    write(
      'probes/audit-chain.probe.yaml',
      'kind: probe\nid: probes.audit-chain\nversion: 1.0.0\ntitle: Audit chain\nowner: test-team\ncheck:\n  kind: auditChain\n',
    );
    write(
      'schedules/audit-chain.schedule.yaml',
      'kind: schedule\nid: schedules.audit-chain\nversion: 1.0.0\ntitle: Audit chain\nowner: test-team\ncron: "0 * * * *"\nenabled: false\njob:\n  kind: probe\n  ref: probes.audit-chain\n',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('wires a process without a database that runs probes and a schedule once, then closes', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
      CONTENT_DIR: path.join(dir, 'content'),
      CONTENT_WATCH: 'false',
      ADMINFORGE_ARTIFACTS_DIR: path.join(dir, 'artifacts'),
    });
    const oneShot = openOneShot(config, { log: silent, noStore: true });
    try {
      expect(oneShot.ctx.database).toBeNull();
      const probes = await oneShot.runProbes(['probes.audit-chain', 'probes.unknown']);
      expect(probes.results.map((r) => [r.key, r.kind, r.outcome.status])).toEqual([
        ['probes.audit-chain', 'auditChain', 'ok'],
      ]);
      expect(probes.missing).toEqual(['probes.unknown']);
      const run = await oneShot.runSchedule('schedules.audit-chain', 'test:operator');
      expect(scheduleRunLines('schedules.audit-chain', run)[0]).toMatch(
        /^schedules\.audit-chain: succeeded \(probes=1 ok=1/,
      );
    } finally {
      await oneShot.close();
    }
  });
});
