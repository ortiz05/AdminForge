import { describePath, hasControlChars } from './graph';
import type { Mode, ServiceId } from './types';

export interface OutboundRequest {
  service: ServiceId;
  method: string;
  /** Path relative to the service root (Graph: without /v1.0; Log Analytics: /v1/workspaces/…). */
  path: string;
  body?: unknown;
  /** Set by the executor only for steps that a *published* definition marks `mode: write`. */
  declaredWrite?: boolean;
  /** Set by the executor only for `function` calls to operations a published connection declares `mode: read`. */
  declaredRead?: boolean;
  /** Exchange/Teams cmdlet name for admin-API calls. */
  cmdlet?: string;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOW: PolicyDecision = { allowed: true };
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });
const SAFE = new Set(['GET', 'HEAD']);

/** POST endpoints that only read. */
const READ_POSTS: Partial<Record<ServiceId, RegExp[]>> = {
  graph: [
    /^\/\$batch$/,
    /^\/security\/runHuntingQuery$/,
    /^\/users\/[^/]+\/(getMemberGroups|getMemberObjects|checkMemberGroups)$/,
    /^\/directoryObjects\/getByIds$/,
  ],
  arm: [
    /^\/providers\/Microsoft\.ResourceGraph\/resources$/i,
    // App settings names only: the API's outbound executor strips the values before anything else sees them (and audits the read).
    /\/providers\/Microsoft\.Web\/sites\/[^/]+(\/slots\/[^/]+)?\/config\/appsettings\/list$/i,
    /\/providers\/Microsoft\.Authorization\/permissions$/i,
    /\/providers\/Microsoft\.Insights\/metrics$/i,
    // Cost Management query/forecast: reads that take their filters as a POST body.
    /^(\/providers\/Microsoft\.Management\/managementGroups\/[^/]+|\/subscriptions\/[^/]+(\/resourceGroups\/[^/]+)?)\/providers\/Microsoft\.CostManagement\/(query|forecast)$/i,
  ],
  logAnalytics: [/^\/v1\/workspaces\/[0-9a-f-]{36}\/query$/i],
};

/**
 * Path without query/fragment; undefined when it is not a clean rooted path (dot segments, encoded separators, or
 * control characters — fetch's URL parser drops TAB/LF/CR before resolving `..`, so `.\t.` is a dot segment there).
 */
export function cleanPath(path: string): string | undefined {
  if (hasControlChars(path)) return undefined;
  const p = path.split(/[?#]/)[0] ?? '';
  if (!p.startsWith('/') || /\\|%2f|%5c/i.test(p)) return undefined;
  if (p.split('/').some((s) => /^(\.|%2e){1,2}$/i.test(s))) return undefined;
  return p;
}

function evaluateBatch(body: unknown): PolicyDecision {
  const requests = (body as { requests?: Array<{ method?: string; url?: string }> } | undefined)?.requests;
  if (!Array.isArray(requests)) return deny('Malformed $batch request.');
  const unclean = requests.find(
    (r) => typeof r.url !== 'string' || cleanPath(r.url.startsWith('/') ? r.url : `/${r.url}`) === undefined,
  );
  if (unclean)
    return deny(`Refusing $batch: ${describePath(String(unclean.url))} is not a clean service path.`);
  const bad = requests.find((r) => !SAFE.has((r.method ?? 'GET').toUpperCase()));
  return bad
    ? deny(`$batch includes ${bad.method} ${bad.url}, which changes data. Arm write access to continue.`)
    : ALLOW;
}

/** What a read-only session may send. */
function evaluateRead(req: OutboundRequest, method: string, path: string): PolicyDecision {
  if (req.service === 'exchange' || req.service === 'teams') {
    return req.cmdlet && /^Get-[A-Za-z]+$/.test(req.cmdlet)
      ? ALLOW
      : deny(
          `Only Get-* cmdlets run in read-only mode (requested ${req.cmdlet ?? 'none'}). Arm write access to continue.`,
        );
  }
  if (req.service === 'runner')
    return req.declaredWrite ? deny('This script changes data. Arm write access to continue.') : ALLOW;
  if (SAFE.has(method)) return ALLOW;
  if (req.service === 'function' && req.declaredRead && !req.declaredWrite) return ALLOW;
  if (method === 'POST' && (READ_POSTS[req.service] ?? []).some((re) => re.test(path)))
    return req.service === 'graph' && path === '/$batch' ? evaluateBatch(req.body) : ALLOW;
  return deny(`${method} ${path} changes data. Arm write access to continue.`);
}

/**
 * Default-deny request policy (ADR-003).
 * Read mode: only safe methods and allowlisted read-only POSTs leave the API ($batch sub-requests are checked one by one).
 * Write mode: everything read mode allows, plus writes declared by published content.
 */
export function evaluate(mode: Mode, req: OutboundRequest): PolicyDecision {
  const method = req.method.toUpperCase();
  const path = cleanPath(req.path);
  if (path === undefined)
    return deny(`Refusing ${method} ${describePath(req.path)}: not a clean service path.`);
  if (mode === 'write') {
    if (req.declaredWrite) return ALLOW;
    const read = evaluateRead(req, method, path);
    return read.allowed ? ALLOW : deny('Write requests must come from a published playbook or action.');
  }
  return evaluateRead(req, method, path);
}
