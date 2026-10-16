import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { DatasourceRunner } from '@adminforge/api/src/datasources/executor';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { createJobRunner, type JobContext } from '@adminforge/api/src/schedules/jobs';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { ApiError } from '@adminforge/connectors';
import { Report, type Schedule } from '@adminforge/schemas';
import { FakeDefinitions, schedule } from './helpers';

// A scheduled report whose `optional` datasource failed (e.g. the automation identity was refused) never succeeds
// silently: the file is written and delivered marked incomplete, and the run fails with `report_incomplete`.

const NOW = new Date('2026-10-16T06:00:00.000Z');

const REPORT = Report.parse({
  kind: 'report',
  id: 'm365.example-teams',
  version: '1.0.0',
  title: 'Example teams',
  owner: 'm365-team',
  datasources: {
    archived: {
      source: 'graph',
      label: 'Archive state of each team',
      optional: true,
      request: { path: '/teams' },
    },
    teams: {
      source: 'graph',
      request: { path: '/groups' },
      paging: 'all',
      transform:
        "${ ( $known := $exists(ds.archived.value); { 'value': value.value.{ 'name': displayName, 'archivedKnown': $known } } ) }",
    },
  },
  layout: [
    {
      widget: 'table',
      data: 'teams.value',
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'archivedKnown', label: 'Archive state known' },
      ],
    },
  ],
  export: { formats: ['csv'], data: 'teams.value', columns: 'all' },
});

class FakeOutbound implements OutboundExecutor {
  constructor(private readonly refuseTeams: boolean) {}
  async execute<T>(_identity: ExecutionIdentity, call: ServiceCall) {
    if (call.path === '/teams' && this.refuseTeams)
      throw new ApiError(403, 'Forbidden', 'Missing application permission.', 'req-1');
    return {
      data: { value: [{ displayName: 'Sales' }, { displayName: 'Ops' }] } as T,
      status: 200,
      provenance: { service: call.service, path: call.path, ms: 1 },
    };
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-report-incomplete-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(refuseTeams: boolean) {
  const registry = registryFrom(new FakeDefinitions().set(REPORT as never) as never, 'fs');
  const outbound = new FakeOutbound(refuseTeams);
  const sent: ServiceCall[] = [];
  const warnings: Array<Record<string, unknown>> = [];
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
    sleep: async () => undefined,
    log: { warn: (obj) => warnings.push(obj as Record<string, unknown>) },
    delivery: {
      outbound: {
        execute: async (_i: unknown, call: ServiceCall) => {
          sent.push(call);
          return { data: null, status: 202, provenance: { service: 'graph', path: '/x', ms: 1 } };
        },
      } as never,
      fetch: (async () => new Response('', { status: 202 })) as never,
      env: { AF_MAIL_SENDER: 'reports@example.com', AF_REPORT_RECIPIENTS: 'ops@example.com' },
      publicBaseUrl: 'https://portal.example.com',
    },
  });
  return { jobs, sent, warnings };
}

function ctx(def: Schedule): JobContext {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    key: def.id,
    source: 'content',
    definition: def,
    sha256: 'x',
    enabled: true,
    createdBy: null,
    approvedBy: null,
    approvedTarget: null,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as ScheduleRow;
  const run = {
    id: '00000000-0000-4000-8000-0000000000aa',
    scheduleId: row.id,
    scheduleKey: row.key,
    trigger: 'cron',
    status: 'running',
    runId: null,
    result: null,
    error: null,
    artifactPath: null,
    startedAt: NOW,
    endedAt: null,
  } as ScheduleRunRow;
  return {
    schedule: row,
    def,
    run,
    signal: new AbortController().signal,
    correlationId: 'c1',
    scheduledBy: null,
  };
}

const weekly = schedule('reports.example-teams-weekly', {
  job: {
    kind: 'report',
    ref: 'm365.example-teams',
    delivery: [{ type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'], format: 'csv' }],
  },
});

const mailText = (call: ServiceCall) =>
  (call.body as { message: { body: { content: string } } }).message.body.content;

describe('scheduled report with a failed optional datasource', () => {
  it('fails with report_incomplete, keeps and delivers the file marked incomplete, and logs it', async () => {
    const { jobs, sent, warnings } = setup(true);
    const r = await jobs.run(ctx(weekly));
    expect(r.status).toBe('failed');
    expect(r.error).toMatchObject({
      code: 'report_incomplete',
      message: expect.stringContaining('“Archive state of each team”'),
    });
    expect(r.result).toMatchObject({
      artifacts: [{ format: 'csv', rows: 2 }],
      incomplete: [{ datasource: 'archived', code: 'upstream_forbidden' }],
    });
    const csv = readFileSync(path.join(dir, r.artifactPath!), 'utf8');
    expect(csv).toContain('Sales,false');
    expect(sent).toHaveLength(1);
    expect(mailText(sent[0]!)).toContain(
      'Incomplete: Archive state of each team couldn’t be read (upstream_forbidden).',
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          report: 'm365.example-teams',
          incomplete: ['archived:upstream_forbidden'],
        }),
      ]),
    );
  });

  it('succeeds without a note when the optional datasource works', async () => {
    const { jobs, sent, warnings } = setup(false);
    const r = await jobs.run(ctx(weekly));
    expect(r.status).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect((r.result as Record<string, unknown>).incomplete).toBeUndefined();
    expect(readFileSync(path.join(dir, r.artifactPath!), 'utf8')).toContain('Sales,true');
    expect(mailText(sent[0]!)).not.toContain('Incomplete');
    expect(warnings).toEqual([]);
  });
});
