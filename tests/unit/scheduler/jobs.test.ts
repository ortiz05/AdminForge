import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, stamp } from '@adminforge/api/src/artifacts/store';
import { DatasourceRunner } from '@adminforge/api/src/datasources/executor';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { contentHealth } from '@adminforge/api/src/schedules/content-health';
import { createJobRunner, type JobContext, type JobDeps } from '@adminforge/api/src/schedules/jobs';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { Report, type Schedule } from '@adminforge/schemas';
import { FakeDefinitions, probe, schedule } from './helpers';

const NOW = new Date('2026-10-15T06:00:00.000Z');

class FakeOutbound implements OutboundExecutor {
  readonly calls: Array<{ identity: ExecutionIdentity; call: ServiceCall }> = [];
  constructor(public respond: (call: ServiceCall) => unknown) {}
  async execute<T>(identity: ExecutionIdentity, call: ServiceCall) {
    this.calls.push({ identity, call });
    return { data: (await this.respond(call)) as T, status: 200, provenance: { service: call.service, path: call.path, ms: 1 } };
  }
}

const REPORT = Report.parse({
  kind: 'report',
  id: 'azure.example-storage',
  version: '1.0.0',
  title: 'Example storage',
  owner: 'azure-team',
  datasources: { rows: { source: 'resourceGraph', query: 'resources | take 5', paging: 'all' } },
  layout: [{ widget: 'table', data: 'rows.value', columns: [{ field: 'name', label: 'Name' }, { field: 'location', label: 'Location' }, { field: 'id', label: 'Id', hidden: true }] }],
  export: { formats: ['csv', 'xlsx'], data: 'rows.value', columns: 'all' },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-artifacts-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(over: Partial<JobDeps> = {}) {
  const defs = new FakeDefinitions().set(REPORT as never);
  const registry = registryFrom(defs as never, 'fs');
  const outbound = new FakeOutbound(() => ({ value: [{ id: '/subscriptions/x/sa1', name: 'sa1', location: 'westeurope' }, { id: '/subscriptions/x/sa2', name: '=cmd()', location: 'northeurope' }], totalRecords: 2 }));
  const store = new MemoryScheduleStore(() => NOW);
  const artifacts = new ArtifactStore(dir);
  const datasources = new DatasourceRunner({ definitions: registry, outbound, env: () => ({}), now: () => NOW });
  const deps: JobDeps = {
    definitions: registry,
    store,
    outbound,
    probes: { automation: null, connection: async () => Promise.reject(new Error('none')), env: () => ({}), now: () => NOW, fetch: async () => new Response('') },
    datasources,
    artifacts,
    runs: null,
    automationClientId: null,
    exportMaxRows: 1000,
    now: () => NOW,
    sleep: async () => undefined,
    ...over,
  };
  return { defs, registry, outbound, store, artifacts, deps, jobs: createJobRunner(deps) };
}

function ctx(def: Schedule, over: Partial<JobContext> = {}): JobContext {
  const row = { id: '00000000-0000-4000-8000-000000000001', key: def.id, source: 'content', definition: def, sha256: 'x', enabled: true, createdBy: null, approvedBy: null, nextRunAt: null, lastRunAt: null, lastStatus: null, createdAt: NOW, updatedAt: NOW } as ScheduleRow;
  const run = { id: '00000000-0000-4000-8000-0000000000aa', scheduleId: row.id, scheduleKey: row.key, trigger: 'cron', status: 'running', runId: null, result: null, error: null, artifactPath: null, startedAt: NOW, endedAt: null } as ScheduleRunRow;
  return { schedule: row, def, run, signal: new AbortController().signal, correlationId: 'c1', scheduledBy: null, ...over };
}

describe('report jobs', () => {
  const reportSchedule = (delivery: unknown[]) => schedule('reports.example-weekly', { job: { kind: 'report', ref: 'azure.example-storage', delivery } });

  it('writes the report as the automation identity to <dir>/<schedule>/<timestamp>.csv', async () => {
    const { jobs, outbound } = setup();
    const r = await jobs.run(ctx(reportSchedule([{ type: 'file', format: 'csv' }])));
    expect(r.artifactPath).toBe(`reports.example-weekly/${stamp(NOW)}.csv`);
    const text = readFileSync(path.join(dir, r.artifactPath!), 'utf8');
    expect(text).toBe('﻿Name,Location,Id\r\nsa1,westeurope,/subscriptions/x/sa1\r\n\'=cmd(),northeurope,/subscriptions/x/sa2\r\n');
    expect(r.result).toMatchObject({ report: 'azure.example-storage', artifacts: [{ format: 'csv', rows: 2, truncated: false, path: r.artifactPath }] });
    expect(outbound.calls.every((c) => c.identity.kind === 'automation' && c.identity.mode === 'read')).toBe(true);
  });

  it('writes one file per format, keeps the newest `retain`, and notes deliveries not built yet', async () => {
    const { jobs } = setup();
    const def = reportSchedule([
      { type: 'file', format: 'xlsx', retain: 2 },
      { type: 'file', format: 'json' },
      { type: 'email', to: ['ops@example.com'] },
    ]);
    for (const old of ['2026-10-01T06-00-00Z', '2026-10-08T06-00-00Z']) {
      mkdirSync(path.join(dir, def.id), { recursive: true });
      writeFileSync(path.join(dir, def.id, `${old}.xlsx`), 'old');
    }
    const r = await jobs.run(ctx(def));
    expect(readdirSync(path.join(dir, def.id)).sort()).toEqual([`2026-10-08T06-00-00Z.xlsx`, `${stamp(NOW)}.json`, `${stamp(NOW)}.xlsx`]);
    const json = JSON.parse(readFileSync(path.join(dir, def.id, `${stamp(NOW)}.json`), 'utf8'));
    expect(json).toMatchObject({ report: 'azure.example-storage', rows: [{ name: 'sa1', location: 'westeurope' }, { name: '=cmd()' }] });
    expect(r.result!.delivery).toEqual([{ type: 'email', status: 'not_supported', message: expect.stringMatching(/not built yet/) }]);
  });

  it('writes a file for email-only deliveries so the run still has its output', async () => {
    const { jobs } = setup();
    const r = await jobs.run(ctx(reportSchedule([{ type: 'teams', webhook: '${ env.AF_TEAMS }' }])));
    expect(r.artifactPath).toMatch(/\.xlsx$/);
  });

  it('fails clearly when the report does not exist', async () => {
    const { jobs } = setup();
    await expect(jobs.run(ctx(schedule('reports.x', { job: { kind: 'report', ref: 'azure.missing', delivery: [{ type: 'file' }] } })))).rejects.toThrow(/No published report/);
  });
});

describe('artifact store', () => {
  it('only resolves well-formed paths inside the directory', async () => {
    const store = new ArtifactStore(dir);
    expect(store.resolve('reports.x/2026-10-15T06-00-00Z.csv')).toBe(path.join(dir, 'reports.x', '2026-10-15T06-00-00Z.csv'));
    for (const bad of ['../etc/passwd', '/etc/passwd', 'reports.x/../../x.csv', 'reports.x/notes.txt', 'reports.x/sub/2026.csv', '..%2f/x.csv', 'Reports/2026.csv'])
      expect(store.resolve(bad)).toBeNull();
    expect(await store.open('reports.x/2026-10-15T06-00-00Z.csv')).toBeNull();
  });
  it('refuses a symlink that leads outside', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'af-outside-'));
    writeFileSync(path.join(outside, 'secret.csv'), 'secret');
    mkdirSync(path.join(dir, 'reports.x'));
    symlinkSync(path.join(outside, 'secret.csv'), path.join(dir, 'reports.x', '2026-10-15T06-00-00Z.csv'));
    expect(await new ArtifactStore(dir).open('reports.x/2026-10-15T06-00-00Z.csv')).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });
  it('never overwrites: a second file in the same second gets a suffix', async () => {
    const store = new ArtifactStore(dir);
    const a = await store.write('reports.x', NOW, 'csv', async (out) => void out.end('a'));
    const b = await store.write('reports.x', NOW, 'csv', async (out) => void out.end('b'));
    expect([a.path, b.path]).toEqual([`reports.x/${stamp(NOW)}.csv`, `reports.x/${stamp(NOW)}-2.csv`]);
    const opened = await store.open(b.path);
    expect(opened).toMatchObject({ size: 1, contentType: 'text/csv; charset=utf-8' });
    const chunks: Buffer[] = [];
    for await (const c of opened!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('b');
  });
});

describe('playbook, script and content-health jobs', () => {
  it('hands a playbook run to the runs worker and follows it to the end', async () => {
    const statuses = ['queued', 'running', 'succeeded'];
    const created: unknown[] = [];
    const runs = {
      service: { createScheduledRun: async (input: unknown) => (created.push(input), { id: 'run-1', status: 'queued' }) },
      repo: { getRun: async () => ({ id: 'run-1', status: statuses.shift() ?? 'succeeded', error: null }) },
    };
    const { jobs } = setup({ runs: runs as never });
    const def = schedule('ops.cleanup', { job: { kind: 'playbook', ref: 'identity.cleanup', inputs: { days: 30 }, mode: 'read' } });
    const r = await jobs.run(ctx(def, { scheduledBy: 'avery@example.com' }));
    expect(r).toMatchObject({ runId: 'run-1', result: { playbook: 'identity.cleanup', runStatus: 'succeeded' } });
    expect(created).toEqual([{ schedule: { id: expect.any(String), key: 'ops.cleanup', createdBy: 'avery@example.com', approvedBy: [] }, playbook: 'identity.cleanup', inputs: { days: 30 }, dryRun: undefined, correlationId: 'c1' }]);
  });

  it('reports a failed or waiting playbook run', async () => {
    const mk = (status: string) => ({ service: { createScheduledRun: async () => ({ id: 'run-2', status: 'queued' }) }, repo: { getRun: async () => ({ id: 'run-2', status, error: status === 'failed' ? { message: 'Step disable failed' } : null }) } });
    const def = schedule('ops.cleanup', { job: { kind: 'playbook', ref: 'identity.cleanup' } });
    expect(await setup({ runs: mk('failed') as never }).jobs.run(ctx(def))).toMatchObject({ status: 'failed', error: { code: 'run_failed', message: 'Step disable failed' } });
    expect(await setup({ runs: mk('awaiting_approval') as never }).jobs.run(ctx(def))).toMatchObject({ result: { runStatus: 'awaiting_approval', handedOver: true } });
  });

  it('records scripts as not supported yet (never runs them)', async () => {
    const def = schedule('ops.script', { job: { kind: 'script', script: 'exchange/Get-Thing.ps1', sha256: 'f'.repeat(64) } });
    await expect(setup().jobs.run(ctx(def))).rejects.toMatchObject({ code: 'script_not_supported' });
  });

  it('content health: problems, lint and scope drift against the automation identity', async () => {
    const defs = new FakeDefinitions()
      .set(probe('probes.g', { requires: { scopes: { graph: ['Organization.Read.All', 'AuditLog.Read.All'] } } }))
      .set(schedule('sweep.a', { job: { kind: 'probe', ref: 'probes.g' }, requires: { scopes: { graph: ['Application.Read.All'] } } }))
      .set(schedule('sweep.broken', { job: { kind: 'probe', ref: 'probes.missing' } }));
    const graphAppId = '00000003-0000-0000-c000-000000000000';
    const outbound = new FakeOutbound((call) => {
      if (call.path === '/servicePrincipals') return { value: [{ id: 'sp-automation' }] };
      if (call.path.endsWith('/appRoleAssignments')) return { value: [{ resourceId: 'sp-graph', appRoleId: 'r1' }, { resourceId: 'sp-graph', appRoleId: 'r2' }, { resourceId: 'sp-graph', appRoleId: 'r3' }] };
      return { appId: graphAppId, appRoles: [{ id: 'r1', value: 'Organization.Read.All' }, { id: 'r2', value: 'Application.ReadWrite.All' }, { id: 'r3', value: 'Mail.Send' }] };
    });
    const report = await contentHealth(defs, { scopes: true, outbound, automationClientId: 'automation-client' });
    expect(report).toMatchObject({ definitions: 3, problems: 1, lintWarnings: 0, scopes: { checked: true, missing: ['graph:AuditLog.Read.All'], unused: ['graph:mail.send'] } });
    expect(report.problemSamples[0]).toMatch(/job.ref: Unknown probe "probes.missing"/);
    expect(outbound.calls.every((c) => c.identity.kind === 'automation')).toBe(true);

    // Permissions of checks the tenant is not licensed for wait for the licence instead of failing the health check.
    defs.set(probe('probes.hunting', { requires: { scopes: { graph: ['ThreatHunting.Read.All'] }, licences: ['defender'] } }));
    const gated = await contentHealth(defs, { scopes: true, outbound, automationClientId: 'automation-client', licensed: async (l) => !l.includes('defender') });
    expect(gated.scopes).toMatchObject({ missing: ['graph:AuditLog.Read.All'], unlicensed: ['probes.hunting'] });
    const unknown = await contentHealth(defs, { scopes: true, outbound, automationClientId: 'automation-client', licensed: async () => null });
    expect(unknown.scopes!.missing).toEqual(['graph:AuditLog.Read.All', 'graph:ThreatHunting.Read.All']);
  });
});
