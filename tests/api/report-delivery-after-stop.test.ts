import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { DatasourceRunner } from '@adminforge/api/src/datasources/executor';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { createJobRunner } from '@adminforge/api/src/schedules/jobs';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { Report } from '@adminforge/schemas';
import { FakeDefinitions, schedule } from './schedules-helpers';

// A report job told to stop (its time limit, the scheduler stopping) while it was still collecting: the scheduler has
// already recorded the run as timed out and may queue a retry, so the leftover job must not email or post the report
// as well — the retry would send it a second time (security review of D-23a).
const NOW = new Date('2026-10-15T06:00:00.000Z');
const REPORT = Report.parse({
  kind: 'report',
  id: 'azure.example-stop',
  version: '1.0.0',
  title: 'Example',
  owner: 'azure-team',
  datasources: { rows: { source: 'resourceGraph', query: 'resources | take 5', paging: 'all' } },
  layout: [{ widget: 'table', data: 'rows.value', columns: [{ field: 'name', label: 'Name' }] }],
  export: { formats: ['csv'], data: 'rows.value', columns: 'all' },
});

/** Answers the report's query, and stops the run while doing so (as a timeout firing mid-collection would). */
class StoppingOutbound implements OutboundExecutor {
  constructor(private readonly stop: () => void) {}
  async execute<T>(_identity: ExecutionIdentity, call: ServiceCall) {
    this.stop();
    return {
      data: { value: [{ name: 'sub-1' }], totalRecords: 1 } as T,
      status: 200,
      provenance: { service: call.service, path: call.path, ms: 1 },
    };
  }
}

describe('a report run told to stop before delivery', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-delivery-stop-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sends neither the email nor the Teams post', async () => {
    const controller = new AbortController();
    const registry = registryFrom(new FakeDefinitions().set(REPORT as never) as never, 'fs');
    const outbound = new StoppingOutbound(() =>
      controller.abort(new Error('Stopped after the 60 s time limit.')),
    );
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
          AF_REPORT_RECIPIENTS: 'ops@example.com',
          AF_TEAMS_WEBHOOK: 'https://example.webhook.office.com/webhookb2/x',
        },
        publicBaseUrl: 'https://portal.example.com',
      },
    });
    const def = schedule('reports.example', {
      job: {
        kind: 'report',
        ref: 'azure.example-stop',
        delivery: [
          { type: 'file', format: 'csv' },
          { type: 'email', to: ['${ env.AF_REPORT_RECIPIENTS }'], format: 'csv' },
          { type: 'teams', webhook: '${ env.AF_TEAMS_WEBHOOK }' },
        ],
      },
    });
    const run = jobs.run({
      schedule: { id: 's1', key: def.id, source: 'content', definition: def, enabled: true } as ScheduleRow,
      def,
      run: { id: 'r1', scheduleId: 's1', scheduleKey: def.id, trigger: 'cron' } as ScheduleRunRow,
      signal: controller.signal,
      correlationId: 'c1',
      scheduledBy: null,
    });
    await expect(run).rejects.toThrow(/time limit/);
    expect(mail).toEqual([]);
    expect(posts).toEqual([]);
  });
});
