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
import { Report, type Schedule } from '@adminforge/schemas';
import { FakeDefinitions, schedule } from './helpers';

// Report delivery for schedules created in the portal: the JSON file is streamed (valid JSON for any number of rows)
// with `redact: true` params masked, and email/Teams messages say who scheduled it.

const NOW = new Date('2026-10-15T06:00:00.000Z');

const REPORT = Report.parse({
  kind: 'report',
  id: 'azure.example-storage',
  version: '1.0.0',
  title: 'Example storage',
  owner: 'azure-team',
  params: {
    costCode: { type: 'string', redact: true },
    days: { type: 'number', default: 30 },
  },
  datasources: { rows: { source: 'resourceGraph', query: 'resources | take 5', paging: 'all' } },
  layout: [
    {
      widget: 'table',
      data: 'rows.value',
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'location', label: 'Location' },
      ],
    },
  ],
  export: { formats: ['csv', 'xlsx'], data: 'rows.value', columns: 'all' },
});

class FakeOutbound implements OutboundExecutor {
  constructor(public rows: Array<Record<string, unknown>>) {}
  async execute<T>(_identity: ExecutionIdentity, call: ServiceCall) {
    return {
      data: { value: this.rows, totalRecords: this.rows.length } as T,
      status: 200,
      provenance: { service: call.service, path: call.path, ms: 1 },
    };
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-portal-delivery-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(rows: Array<Record<string, unknown>>, delivery?: Record<string, unknown>) {
  const registry = registryFrom(new FakeDefinitions().set(REPORT as never) as never, 'fs');
  const outbound = new FakeOutbound(rows);
  const sent: ServiceCall[] = [];
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
    sleep: async () => undefined,
    ...(delivery
      ? {
          delivery: {
            outbound: {
              execute: async (_i: unknown, call: ServiceCall) => {
                sent.push(call);
                return { data: null, status: 202, provenance: { service: 'graph', path: '/x', ms: 1 } };
              },
            } as never,
            fetch: (async (_url: string, init: RequestInit) => {
              posts.push(String(init.body));
              return new Response('', { status: 202 });
            }) as never,
            env: {
              AF_MAIL_SENDER: 'reports@example.com',
              AF_REPORT_RECIPIENTS: 'ops@example.com',
              AF_TEAMS_WEBHOOK: 'https://example.webhook.office.com/webhookb2/x',
            },
            publicBaseUrl: 'https://portal.example.com',
            ...delivery,
          },
        }
      : {}),
  });
  return { jobs, sent, posts };
}

function ctx(def: Schedule, source: 'content' | 'portal'): JobContext {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    key: def.id,
    source,
    definition: def,
    sha256: 'x',
    enabled: true,
    createdBy: source === 'portal' ? '00000000-0000-4000-8000-0000000000a1' : null,
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

const portalSchedule = (delivery: unknown[], title = 'Storage, weekly') =>
  schedule('portal.azure-example-storage-abc123', {
    title,
    owner: 'avery@example.com',
    job: { kind: 'report', ref: 'azure.example-storage', params: { costCode: 'CC-1234', days: 7 }, delivery },
  });

describe('JSON report files', () => {
  it.each([
    [[] as Array<Record<string, unknown>>],
    [[{ name: 'sa1', location: 'westeurope' }]],
    [Array.from({ length: 250 }, (_, i) => ({ name: `sa${i}`, location: 'northeurope' }))],
  ])('streams valid JSON (%#) with redacted params masked', async (rows) => {
    const { jobs } = setup(rows);
    const r = await jobs.run(ctx(portalSchedule([{ type: 'file', format: 'json' }]), 'portal'));
    const text = readFileSync(path.join(dir, r.artifactPath!), 'utf8');
    expect(text).not.toContain('CC-1234');
    const json = JSON.parse(text);
    expect(json).toEqual({
      report: 'azure.example-storage',
      version: '1.0.0',
      generatedAt: NOW.toISOString(),
      params: { costCode: '[redacted]', days: 7 },
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'location', label: 'Location' },
      ],
      rows,
      truncated: false,
    });
    expect(r.result).toMatchObject({ artifacts: [{ format: 'json', rows: rows.length }] });
  });
});

describe('portal schedule messages', () => {
  it('email and Teams say who scheduled it; the typed name is escaped in Teams', async () => {
    const { jobs, sent, posts } = setup([{ name: 'sa1', location: 'westeurope' }], {});
    await jobs.run(
      ctx(
        portalSchedule(
          [
            { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'], format: 'csv' },
            { type: 'teams', webhook: '${ env.AF_TEAMS_WEBHOOK }' },
          ],
          'Storage *weekly*',
        ),
        'portal',
      ),
    );
    const mail = (sent[0]!.body as { message: { body: { content: string } } }).message.body.content;
    expect(mail).toContain('Scheduled in AdminForge by avery@example.com.');
    const card = JSON.parse(posts[0]!) as {
      attachments: Array<{ content: { body: Array<{ text: string }> } }>;
    };
    const texts = card.attachments[0]!.content.body.map((b) => b.text);
    expect(texts[0]).toContain('Storage \\*weekly\\*');
    expect(texts.at(-1)).toContain('Scheduled in AdminForge by avery@example.com.');
  });

  it('content schedules keep their reviewed Markdown message and have no byline', async () => {
    const { jobs, posts } = setup([{ name: 'sa1', location: 'westeurope' }], {});
    const def = schedule('reports.storage-weekly', {
      job: {
        kind: 'report',
        ref: 'azure.example-storage',
        delivery: [{ type: 'teams', webhook: '${ env.AF_TEAMS_WEBHOOK }', message: 'See **this week**.' }],
      },
    });
    await jobs.run(ctx(def, 'content'));
    const card = JSON.parse(posts[0]!) as {
      attachments: Array<{ content: { body: Array<{ text: string }> } }>;
    };
    const texts = card.attachments[0]!.content.body.map((b) => b.text);
    expect(texts[1]).toBe('See **this week**.');
    expect(texts.join('\n')).not.toContain('Scheduled in AdminForge');
  });
});
