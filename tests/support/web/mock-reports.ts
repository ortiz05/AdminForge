/**
 * Mock Reports API (`reportsApi(opts)` → `{ handler, state }`): the report catalogue and portal report schedules —
 * catalogue and detail, delivery options, create/update/delete/pause schedules, run now and run history — answered
 * from fixtures/reports.ts with the API's own refusals (e.g. at most hourly). `state` records what the UI sent.
 *
 * A transport-free `MockHandler` (mock-handler.ts) used by the reports e2e spec (through
 * tests/e2e/support/mock-api.ts), component/reports and unit/web/reports-catalog.
 */
import {
  DEFAULT_COLUMNS,
  DELIVERY_OPTIONS,
  REPORT_AREAS,
  REPORT_COLUMNS,
  REPORTS,
  reportScheduleRuns,
  reportSchedules,
  type ScheduleFixture,
} from './fixtures/reports';
import type { MockHandler, MockReply } from './mock-handler';

const error = (status: number, code: string, message: string, hint?: string): MockReply => ({
  status,
  body: {
    error: {
      code,
      message,
      ...(hint ? { hint } : {}),
      correlationId: '7c1e4b2a-0d3f-4e5a-9b6c-8d7e6f5a4b3c',
    },
  },
});

/** At most hourly, like the API: a minute field that steps or is `*`, or several minutes in one hour, is refused. */
function tooFrequent(cron: string): boolean {
  const [min = ''] = cron.trim().split(/\s+/);
  return min === '*' || min.includes('/') || min.includes(',') || min.includes('-');
}

interface ScheduleBody {
  title: string;
  cron: string;
  timezone: string;
  job: {
    kind: string;
    ref: string;
    params?: Record<string, unknown>;
    format: string;
    retain?: number;
    emailKey?: string;
    teamsKey?: string;
  };
  notifyOnFailure?: { emailKey?: string; teamsKey?: string };
}

const labelOf = (key: string) =>
  [...DELIVERY_OPTIONS.email.lists, ...DELIVERY_OPTIONS.teams.lists].find((l) => l.key === key)?.label ?? key;

function applyBody(s: ScheduleFixture, b: ScheduleBody): ScheduleFixture {
  return {
    ...s,
    title: b.title,
    cron: b.cron,
    timezone: b.timezone,
    job: { kind: 'report', ref: b.job.ref, ...(b.job.params ? { params: b.job.params } : {}) },
    delivery: [
      { type: 'file', format: b.job.format, retain: b.job.retain ?? 26 },
      ...(b.job.emailKey
        ? [{ type: 'email', key: b.job.emailKey, label: labelOf(b.job.emailKey), format: b.job.format }]
        : []),
      ...(b.job.teamsKey ? [{ type: 'teams', key: b.job.teamsKey, label: labelOf(b.job.teamsKey) }] : []),
    ],
    notify: [
      ...(b.notifyOnFailure?.emailKey
        ? [{ type: 'email', key: b.notifyOnFailure.emailKey, label: labelOf(b.notifyOnFailure.emailKey) }]
        : []),
      ...(b.notifyOnFailure?.teamsKey
        ? [{ type: 'teams', key: b.notifyOnFailure.teamsKey, label: labelOf(b.notifyOnFailure.teamsKey) }]
        : []),
    ],
  };
}

export interface ReportsMockOptions {
  /** The installation has no mail sender. */
  noEmail?: boolean;
}

/**
 * Stateful mock of the report catalogue and portal report schedules for Playwright and component tests:
 * GET /api/reports(/:key), GET /api/schedules(/delivery-options), POST/PUT/DELETE/PATCH /api/schedules…, run now and
 * run history. `state` records what the UI sent.
 */
export function reportsApi(opts: ReportsMockOptions = {}) {
  const state = {
    schedules: reportSchedules(),
    posts: [] as ScheduleBody[],
    puts: [] as Array<{ key: string; body: ScheduleBody }>,
    deletes: [] as string[],
    patches: [] as Array<{ key: string; body: unknown }>,
    runs: [] as string[],
  };

  const summary = (s: ScheduleFixture) => ({
    key: s.key,
    title: s.title,
    cron: s.cron,
    cronText: s.cronText,
    timezone: s.timezone,
    enabled: s.enabled,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    source: s.source,
    createdBy: s.createdBy,
    canManage: s.canManage,
    pendingApprovalId: s.pendingApprovalId,
  });

  const item = (r: (typeof REPORTS)[number]) => ({
    ...r,
    area: r.key.split('.')[0]!,
    href: `/p/${r.key}`,
    schedulable: r.exportFormats.length > 0,
    schedules: state.schedules.filter((s) => s.job.ref === r.key).map(summary),
  });

  const handler: MockHandler = ({ method, path, body }) => {
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/api/reports')
      return { body: { items: REPORTS.map(item), areas: REPORT_AREAS } };
    if (method === 'GET' && (m = /^\/api\/reports\/([^/]+)$/.exec(path))) {
      const r = REPORTS.find((x) => x.key === decodeURIComponent(m![1]!));
      return r
        ? { body: { ...item(r), columns: REPORT_COLUMNS[r.key] ?? DEFAULT_COLUMNS } }
        : error(404, 'definition_not_found', 'There’s no published report with that key.');
    }
    if (method === 'GET' && path === '/api/schedules/delivery-options')
      return {
        body: opts.noEmail
          ? { ...DELIVERY_OPTIONS, email: { available: false, lists: [] } }
          : DELIVERY_OPTIONS,
      };
    if (method === 'GET' && path === '/api/schedules') return { body: { items: state.schedules } };

    if (method === 'POST' && path === '/api/schedules') {
      const b = body as ScheduleBody;
      state.posts.push(b);
      if (b.job.kind !== 'report')
        return error(400, 'job_not_allowed', 'Only report schedules can be created in the portal.');
      if (tooFrequent(b.cron))
        return error(
          400,
          'cron_too_frequent',
          'Reports can run at most once an hour.',
          'Choose Every hour or a slower cadence, or a cron expression with at least 60 minutes between runs.',
        );
      const created = applyBody(
        {
          ...reportSchedules()[0]!,
          key: `portal.${b.job.ref.replace(/\./g, '-')}-c0ffee`,
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          lastStatus: null,
          source: 'portal',
          createdBy: 'mock.engineer@example.com',
          canManage: true,
        },
        b,
      );
      state.schedules.push(created);
      return { status: 201, body: created };
    }
    if ((m = /^\/api\/schedules\/([^/]+)$/.exec(path)) && ['PUT', 'DELETE', 'PATCH'].includes(method)) {
      const key = decodeURIComponent(m[1]!);
      const i = state.schedules.findIndex((s) => s.key === key);
      if (i < 0) return error(404, 'schedule_not_found', 'There’s no schedule with that key.');
      const s = state.schedules[i]!;
      if (method === 'PATCH') {
        state.patches.push({ key, body });
        state.schedules[i] = { ...s, enabled: (body as { enabled: boolean }).enabled };
        return { body: { key, enabled: state.schedules[i]!.enabled } };
      }
      if (s.source === 'content')
        return error(
          409,
          'schedule_is_content',
          'This schedule is defined in content; change its YAML and publish it.',
        );
      if (method === 'PUT') {
        const b = body as ScheduleBody;
        state.puts.push({ key, body: b });
        if (tooFrequent(b.cron))
          return error(400, 'cron_too_frequent', 'Reports can run at most once an hour.');
        state.schedules[i] = applyBody(s, b);
        return { body: state.schedules[i] };
      }
      state.deletes.push(key);
      state.schedules.splice(i, 1);
      return { status: 204 };
    }
    if (method === 'POST' && (m = /^\/api\/schedules\/([^/]+)\/run$/.exec(path))) {
      state.runs.push(decodeURIComponent(m[1]!));
      return { status: 202, body: { scheduleRunId: 'sr-now' } };
    }
    if (method === 'GET' && (m = /^\/api\/schedules\/([^/]+)\/runs$/.exec(path)))
      return { body: reportScheduleRuns(decodeURIComponent(m[1]!)) };
    return undefined;
  };

  return { handler, state };
}
