import {
  approvalRunDetail,
  approvalTask,
  appearance,
  auditEvents,
  auditEventsOlder,
  auditVerify,
  bulkDetail,
  CHILD_TAP_VALUE,
  capabilities,
  DEFINITIONS,
  failedDetail,
  IDS,
  liveDetail,
  liveEvents,
  onboardDetail,
  onboardEvents,
  previewDetail,
  probes,
  readPreviewDetail,
  runbookRunDetail,
  runsList,
  scheduleRuns,
  schedules,
  searchResults,
  secretMessage,
  settings,
  tapDetail,
  tapEvents,
} from '../fixtures/automation';
import type { MockHandler, MockReply } from './mock-api';

const notFound = (what: string): MockReply => ({ status: 404, body: { error: { code: 'not_found', message: `No mock for ${what}` } } });
const sse = (text: string): MockReply => ({ text, contentType: 'text/event-stream' });

export interface AutomationOptions {
  /** Approvals inbox status (403 for non-approvers). */
  approvalsStatus?: number;
}

/**
 * Stateful mock of the automation APIs (runs, approvals, schedules, probes, audit, appearance, settings) for
 * Playwright and component tests. `state` records what the UI sent so tests can assert on it.
 */
export function automationApi(opts: AutomationOptions = {}) {
  const state = {
    liveServed: false,
    runPosts: [] as unknown[],
    bulkPosts: [] as unknown[],
    decisions: [] as Array<{ path: string; body: unknown }>,
    manual: [] as Array<{ path: string; body: unknown }>,
    schedulePatches: [] as Array<{ key: string; body: unknown }>,
    scheduleRuns: [] as string[],
    appearancePuts: [] as unknown[],
    appearanceVersion: 3,
    enabled: new Map<string, boolean>(),
    pending: new Set<string>(),
    cancelled: [] as string[],
    /** Held secrets claimed (GET …/secret/:path) and whether the CSRF header came with it. */
    secretClaims: [] as Array<{ path: string; csrf: boolean }>,
    secretClaimed: false,
  };

  const runDetail = (id: string): MockReply => {
    switch (id) {
      case IDS.previewRun:
        return { body: previewDetail() };
      case IDS.readRun:
        return { body: readPreviewDetail() };
      case IDS.liveRun:
        return { body: liveDetail(state.liveServed ? 'done' : 'running') };
      case IDS.bulkRun:
        return { body: bulkDetail() };
      case IDS.approvalRun:
        return { body: approvalRunDetail() };
      case IDS.failedRun:
        return { body: failedDetail() };
      case IDS.runbookRun:
        return { body: runbookRunDetail() };
      case IDS.tapRun:
        return { body: tapDetail() };
      case IDS.onboardRun:
        return { body: onboardDetail() };
      default:
        return notFound(`run ${id}`);
    }
  };

  const handler: MockHandler = ({ method, path, url, body, csrf }) => {
    const q = url.searchParams;
    let m: RegExpExecArray | null;

    if (method === 'GET' && (m = /^\/api\/definitions\/(\w+)\/([^/]+)$/.exec(path))) {
      const def = DEFINITIONS[`${m[1]}:${decodeURIComponent(m[2]!)}`];
      return def ? { body: def } : { status: 404, body: { error: { code: 'definition_not_found', message: `No published ${m[1]} "${m[2]}".` } } };
    }
    if (method === 'GET' && path === '/api/me/capabilities') return { body: capabilities };
    if (method === 'GET' && path === '/api/search') return { body: searchResults(q.get('q') ?? '', q.get('type')) };

    // Runs
    if (method === 'POST' && path === '/api/runs') {
      state.runPosts.push(body);
      const b = body as { playbook: string; dryRun?: boolean };
      if (b.playbook === 'diagnostics.user-sign-in-check') return { status: 202, body: { runId: IDS.readRun, status: 'queued' } };
      if (b.playbook === 'identity.offboard-leaver') return { status: 202, body: { runId: IDS.runbookRun, status: 'queued' } };
      return { status: 202, body: { runId: b.dryRun ? IDS.previewRun : IDS.liveRun, status: 'queued' } };
    }
    if (method === 'POST' && path === '/api/runs/bulk') {
      state.bulkPosts.push(body);
      return { status: 202, body: { runId: IDS.bulkRun, status: 'queued', items: (body as { items: unknown[] }).items.length } };
    }
    if (method === 'GET' && path === '/api/runs') {
      const list = runsList().items as unknown as Array<{ status: string; initiatorUpn: string | null }>;
      if (q.get('status') === 'active') return { body: { items: list.filter((r) => !['succeeded', 'failed', 'cancelled', 'compensated', 'needs_review'].includes(r.status)).slice(0, 3) } };
      return { body: { items: q.get('scope') === 'all' ? list : list.filter((r) => r.initiatorUpn === 'mock.engineer@example.com' || r.initiatorUpn === null) } };
    }
    if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)\/events$/.exec(path))) {
      // Like the API, every connection replays the run's events from the start (no Last-Event-ID on a new stream).
      if (m[1] === IDS.liveRun) {
        state.liveServed = true;
        return sse(liveEvents());
      }
      if (m[1] === IDS.tapRun) return sse(tapEvents());
      if (m[1] === IDS.onboardRun) return sse(onboardEvents());
      return sse('retry: 600000\n\nevent: end\ndata: {}\n\n');
    }
    if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)\/secret\/([^/]+)$/.exec(path))) {
      state.secretClaims.push({ path, csrf: Boolean(csrf) });
      if (state.secretClaimed || m[1] !== IDS.onboardChild)
        return { status: 404, body: { error: { code: 'secret_not_available', message: 'This secret was already shown or has expired.' } } };
      state.secretClaimed = true;
      const { type: _t, ...rest } = secretMessage(IDS.onboardChild, CHILD_TAP_VALUE);
      return { body: rest };
    }
    if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)$/.exec(path))) return runDetail(m[1]!);
    if (method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/(cancel|resume)$/.exec(path))) {
      if (m[2] === 'cancel') state.cancelled.push(m[1]!);
      return { status: m[2] === 'resume' ? 202 : 200, body: { runId: m[1], status: m[2] === 'cancel' ? 'cancelled' : 'running' } };
    }
    if (method === 'POST' && /^\/api\/runs\/[^/]+\/approvals\/[^/]+$/.test(path)) {
      state.decisions.push({ path, body });
      return { body: { status: (body as { decision: string }).decision === 'approve' ? 'approved' : 'rejected', approvals: 1, required: 1 } };
    }
    if (method === 'POST' && /^\/api\/runs\/[^/]+\/manual\/[^/]+$/.test(path)) {
      state.manual.push({ path, body });
      return { body: { status: 'confirmed' } };
    }
    if (method === 'GET' && path === '/api/approvals') {
      if (opts.approvalsStatus) return { status: opts.approvalsStatus, body: { error: { code: 'forbidden', message: 'The approval inbox needs the Playbook.Approver role.' } } };
      const decided = state.decisions.length > 0;
      return { body: { items: (q.get('status') ?? 'pending') === 'pending' && !decided ? [approvalTask()] : [] } };
    }

    // Schedules and probes
    if (method === 'GET' && path === '/api/schedules') {
      const items = schedules().items.map((s) => ({
        ...s,
        enabled: state.enabled.get(s.key) ?? s.enabled,
        ...(state.pending.has(s.key) ? { pendingApprovalId: 'appr-1' } : {}),
      }));
      return { body: { items } };
    }
    if (method === 'PATCH' && (m = /^\/api\/schedules\/([^/]+)$/.exec(path))) {
      const key = decodeURIComponent(m[1]!);
      state.schedulePatches.push({ key, body });
      const sched = schedules().items.find((s) => s.key === key);
      const enabled = (body as { enabled: boolean }).enabled;
      if (sched?.writeCapable && enabled) {
        state.pending.add(key);
        return { status: 202, body: { approvalId: 'appr-1' } };
      }
      state.enabled.set(key, enabled);
      return { body: { key, enabled } };
    }
    if (method === 'POST' && (m = /^\/api\/schedules\/([^/]+)\/run$/.exec(path))) {
      state.scheduleRuns.push(decodeURIComponent(m[1]!));
      return { status: 202, body: { scheduleRunId: 'sr-new' } };
    }
    if (method === 'GET' && (m = /^\/api\/schedules\/([^/]+)\/runs$/.exec(path))) return { body: scheduleRuns(decodeURIComponent(m[1]!)) };
    if (method === 'GET' && path === '/api/probes') return { body: probes() };
    if (method === 'GET' && (m = /^\/api\/probes\/([^/]+)\/results$/.exec(path))) {
      const p = probes().items.find((x) => x.key === decodeURIComponent(m![1]!));
      return { body: { items: p?.series ?? [] } };
    }

    // Admin
    if (method === 'GET' && path === '/api/audit') {
      if (q.get('action') === 'appearance.updated')
        return { body: { items: auditEvents().items.filter((e) => (e as { action?: string }).action === 'appearance.updated') } };
      if (q.get('cursor')) return { body: auditEventsOlder() };
      const items = auditEvents().items.filter((e) => !q.get('actor') || (e.actorUpn ?? '').includes(q.get('actor')!));
      return { body: { items, ...(q.get('actor') ? {} : { cursor: auditEvents().cursor }) } };
    }
    if (method === 'GET' && path === '/api/audit/verify') return { body: auditVerify };
    if (method === 'GET' && path === '/api/admin/appearance') return { body: { ...appearance(), version: state.appearanceVersion } };
    if (method === 'PUT' && path === '/api/admin/appearance') {
      state.appearancePuts.push(body);
      state.appearanceVersion += 1;
      const { version: _v, ...rest } = body as Record<string, unknown>;
      return { body: { version: state.appearanceVersion, ...rest } };
    }
    if (method === 'GET' && path === '/api/admin/settings') return { body: settings() };
    return undefined;
  };

  return { handler, state };
}
