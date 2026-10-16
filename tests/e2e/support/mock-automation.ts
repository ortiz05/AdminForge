import {
  approvalRunDetail,
  approvalTask,
  appearance,
  auditEvents,
  auditEventsOlder,
  auditVerify,
  bulkDetail,
  bulkPreviewDetail,
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

const previewRefusal = (code: string, message: string): MockReply => ({
  status: 409,
  body: { error: { code, message, hint: 'Nothing ran. Preview again, then confirm.' } },
});
const notFound = (what: string): MockReply => ({
  status: 404,
  body: { error: { code: 'not_found', message: `No mock for ${what}` } },
});
const sse = (text: string): MockReply => ({ text, contentType: 'text/event-stream' });

export interface AutomationOptions {
  /** Approvals inbox status (403 for non-approvers). */
  approvalsStatus?: number;
  /** The first preview is older than the server's 15-minute limit. */
  stalePreview?: boolean;
  /** The first real run is refused: 409 preview_stale (the server lost or aged the preview). */
  refuseStaleOnce?: boolean;
  /** The first typed confirmation is refused with 422 confirmation_mismatch. */
  mismatchOnce?: boolean;
  /** What the viewer may do with the emergency stop (default: an admin — both). */
  emergency?: { canPause: boolean; canResume: boolean; writesPausedBy?: string };
}

/** Typed confirmations the mock server expects ("preview then confirm"). */
const EXPECTED_CONFIRMATION: Record<string, string> = {
  'identity.disable-user': 'a.lee@example.com',
  'identity.issue-tap': 'm.chen@example.com',
};

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
    previews: 0,
    refusals: { stale: Boolean(opts.refuseStaleOnce), mismatch: Boolean(opts.mismatchOnce) },
    /** Emergency stop: what's paused, and every PUT the UI sent (with whether CSRF came along). */
    emergency: {
      writes: opts.emergency?.writesPausedBy
        ? {
            paused: true,
            reason: 'Suspected compromised operator account',
            by: opts.emergency.writesPausedBy,
            at: '2026-10-15T11:30:00.000Z',
          }
        : {
            paused: false,
            reason: null as string | null,
            by: null as string | null,
            at: null as string | null,
          },
      automation: {
        paused: false,
        reason: null as string | null,
        by: null as string | null,
        at: null as string | null,
      },
    },
    emergencyPuts: [] as Array<{ body: unknown; csrf: boolean }>,
  };

  const runDetail = (id: string): MockReply => {
    switch (id) {
      case IDS.previewRun:
        return { body: previewDetail(undefined, opts.stalePreview ? { endedAgoMs: 20 * 60_000 } : {}) };
      case IDS.previewRun2:
        return { body: previewDetail(undefined, { id: IDS.previewRun2, endedAgoMs: 5_000 }) };
      case IDS.bulkPreview:
        return { body: bulkPreviewDetail() };
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
      return def
        ? { body: def }
        : {
            status: 404,
            body: { error: { code: 'definition_not_found', message: `No published ${m[1]} "${m[2]}".` } },
          };
    }
    if (method === 'GET' && path === '/api/me/capabilities') return { body: capabilities };
    if (method === 'GET' && path === '/api/search')
      return { body: searchResults(q.get('q') ?? '', q.get('type')) };

    // Runs
    if (method === 'POST' && path === '/api/runs') {
      state.runPosts.push(body);
      const b = body as { playbook: string; dryRun?: boolean; previewRunId?: string; confirmation?: string };
      if (b.playbook === 'diagnostics.user-sign-in-check')
        return { status: 202, body: { runId: IDS.readRun, status: 'queued' } };
      if (b.playbook === 'identity.offboard-leaver')
        return { status: 202, body: { runId: IDS.runbookRun, status: 'queued' } };
      if (b.dryRun)
        return {
          status: 202,
          body: { runId: state.previews++ === 0 ? IDS.previewRun : IDS.previewRun2, status: 'queued' },
        };
      // "Preview then confirm": write runs carry the dry run and, for typed confirmation, what was typed.
      const expected = EXPECTED_CONFIRMATION[b.playbook];
      if (expected) {
        if (!b.previewRunId)
          return previewRefusal('preview_required', 'Preview this playbook before running it.');
        if (state.refusals.stale) {
          state.refusals.stale = false;
          return previewRefusal(
            'preview_stale',
            'The preview is more than 15 minutes old, or its inputs changed.',
          );
        }
        if (state.refusals.mismatch || b.confirmation !== expected) {
          state.refusals.mismatch = false;
          return {
            status: 422,
            body: {
              error: {
                code: 'confirmation_mismatch',
                message: 'That doesn’t match. Type the sign-in name exactly as shown.',
              },
            },
          };
        }
      }
      return { status: 202, body: { runId: IDS.liveRun, status: 'queued' } };
    }
    if (method === 'POST' && path === '/api/runs/bulk') {
      state.bulkPosts.push(body);
      const b = body as {
        playbook: string;
        items: unknown[];
        dryRun?: boolean;
        previewRunId?: string;
        confirmation?: string;
      };
      if (b.dryRun)
        return { status: 202, body: { runId: IDS.bulkPreview, status: 'queued', items: b.items.length } };
      if (EXPECTED_CONFIRMATION[b.playbook]) {
        if (!b.previewRunId)
          return previewRefusal('preview_required', 'Preview this playbook before running it.');
        if (b.confirmation !== String(b.items.length))
          return {
            status: 422,
            body: {
              error: {
                code: 'confirmation_mismatch',
                message: `Type ${b.items.length} to confirm changing ${b.items.length} objects.`,
              },
            },
          };
      }
      return { status: 202, body: { runId: IDS.bulkRun, status: 'queued', items: b.items.length } };
    }
    if (method === 'GET' && path === '/api/runs') {
      const list = runsList().items as unknown as Array<{ status: string; initiatorUpn: string | null }>;
      if (q.get('status') === 'active')
        return {
          body: {
            items: list
              .filter(
                (r) =>
                  !['succeeded', 'failed', 'cancelled', 'compensated', 'needs_review'].includes(r.status),
              )
              .slice(0, 3),
          },
        };
      return {
        body: {
          items:
            q.get('scope') === 'all'
              ? list
              : list.filter((r) => r.initiatorUpn === 'mock.engineer@example.com' || r.initiatorUpn === null),
        },
      };
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
        return {
          status: 404,
          body: {
            error: { code: 'secret_not_available', message: 'This secret was already shown or has expired.' },
          },
        };
      state.secretClaimed = true;
      const { type: _t, ...rest } = secretMessage(IDS.onboardChild, CHILD_TAP_VALUE);
      return { body: rest };
    }
    if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)$/.exec(path))) return runDetail(m[1]!);
    if (method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/(cancel|resume)$/.exec(path))) {
      if (m[2] === 'cancel') state.cancelled.push(m[1]!);
      return {
        status: m[2] === 'resume' ? 202 : 200,
        body: { runId: m[1], status: m[2] === 'cancel' ? 'cancelled' : 'running' },
      };
    }
    if (method === 'POST' && /^\/api\/runs\/[^/]+\/approvals\/[^/]+$/.test(path)) {
      state.decisions.push({ path, body });
      return {
        body: {
          status: (body as { decision: string }).decision === 'approve' ? 'approved' : 'rejected',
          approvals: 1,
          required: 1,
        },
      };
    }
    if (method === 'POST' && /^\/api\/runs\/[^/]+\/manual\/[^/]+$/.test(path)) {
      state.manual.push({ path, body });
      return { body: { status: 'confirmed' } };
    }
    if (method === 'GET' && path === '/api/approvals') {
      if (opts.approvalsStatus)
        return {
          status: opts.approvalsStatus,
          body: {
            error: { code: 'forbidden', message: 'The approval inbox needs the Playbook.Approver role.' },
          },
        };
      const decided = state.decisions.length > 0;
      return {
        body: { items: (q.get('status') ?? 'pending') === 'pending' && !decided ? [approvalTask()] : [] },
      };
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
    if (method === 'GET' && (m = /^\/api\/schedules\/([^/]+)\/runs$/.exec(path)))
      return { body: scheduleRuns(decodeURIComponent(m[1]!)) };
    if (method === 'GET' && path === '/api/probes') return { body: probes() };
    if (method === 'GET' && (m = /^\/api\/probes\/([^/]+)\/results$/.exec(path))) {
      const p = probes().items.find((x) => x.key === decodeURIComponent(m![1]!));
      return { body: { items: p?.series ?? [] } };
    }

    // Admin
    if (method === 'GET' && path === '/api/audit') {
      if (q.get('action') === 'appearance.updated')
        return {
          body: {
            items: auditEvents().items.filter(
              (e) => (e as { action?: string }).action === 'appearance.updated',
            ),
          },
        };
      if (q.get('cursor')) return { body: auditEventsOlder() };
      const items = auditEvents().items.filter(
        (e) => !q.get('actor') || (e.actorUpn ?? '').includes(q.get('actor')!),
      );
      return { body: { items, ...(q.get('actor') ? {} : { cursor: auditEvents().cursor }) } };
    }
    if (method === 'GET' && path === '/api/audit/verify') return { body: auditVerify };
    if (method === 'GET' && path === '/api/admin/appearance')
      return { body: { ...appearance(), version: state.appearanceVersion } };
    if (method === 'PUT' && path === '/api/admin/appearance') {
      state.appearancePuts.push(body);
      state.appearanceVersion += 1;
      const { version: _v, ...rest } = body as Record<string, unknown>;
      return { body: { version: state.appearanceVersion, ...rest } };
    }
    if (method === 'GET' && path === '/api/admin/settings') return { body: settings() };
    if (method === 'GET' && path === '/api/emergency')
      return {
        body: {
          ...state.emergency,
          canPause: opts.emergency?.canPause ?? true,
          canResume: opts.emergency?.canResume ?? true,
        },
      };
    if (method === 'PUT' && path === '/api/admin/emergency') {
      state.emergencyPuts.push({ body, csrf: Boolean(csrf) });
      const b = body as { target: 'writes' | 'automation'; paused: boolean; reason?: string };
      state.emergency[b.target] = b.paused
        ? {
            paused: true,
            reason: b.reason ?? null,
            by: 'mock.engineer@example.com',
            at: '2026-10-15T12:00:00.000Z',
          }
        : { paused: false, reason: null, by: null, at: null };
      return {
        body: {
          ...state.emergency,
          canPause: opts.emergency?.canPause ?? true,
          canResume: opts.emergency?.canResume ?? true,
        },
      };
    }
    return undefined;
  };

  return { handler, state };
}
