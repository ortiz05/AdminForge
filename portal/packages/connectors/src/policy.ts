import type { Mode, ServiceId } from './types';

export interface OutboundRequest {
  service: ServiceId;
  method: string;
  path: string;
  body?: unknown;
  /** Set by the executor only for steps that a *published* definition marks `mode: write`. */
  declaredWrite?: boolean;
  /** Exchange/Teams cmdlet name for admin-API calls. */
  cmdlet?: string;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOW: PolicyDecision = { allowed: true };
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });
const SAFE = new Set(['GET', 'HEAD']);

/** POST endpoints that only read. */
const READ_POSTS: Partial<Record<ServiceId, RegExp[]>> = {
  graph: [/^\/\$batch$/, /^\/security\/runHuntingQuery$/, /^\/users\/[^/]+\/(getMemberGroups|getMemberObjects|checkMemberGroups)$/],
  arm: [
    /^\/providers\/Microsoft\.ResourceGraph\/resources$/i,
    /\/providers\/Microsoft\.Authorization\/permissions$/i,
    /\/providers\/Microsoft\.Insights\/metrics$/i,
  ],
  logAnalytics: [/^\/v1\/workspaces\/[0-9a-f-]{36}\/query$/i],
};

const isReadPost = (r: OutboundRequest) =>
  r.method.toUpperCase() === 'POST' && (READ_POSTS[r.service] ?? []).some((re) => re.test(r.path));

function evaluateBatch(body: unknown): PolicyDecision {
  const requests = (body as { requests?: Array<{ method?: string; url?: string }> } | undefined)?.requests;
  if (!Array.isArray(requests)) return deny('Malformed $batch request.');
  const bad = requests.find((r) => !SAFE.has((r.method ?? 'GET').toUpperCase()));
  return bad ? deny(`$batch includes ${bad.method} ${bad.url}, which changes data. Arm write access to continue.`) : ALLOW;
}

/**
 * Default-deny request policy (ADR-003).
 * Read mode: only safe methods and allowlisted read-only POSTs leave the API.
 * Write mode: anything safe, plus writes declared by published content.
 */
export function evaluate(mode: Mode, req: OutboundRequest): PolicyDecision {
  const method = req.method.toUpperCase();
  if (mode === 'write') {
    if (SAFE.has(method) || isReadPost(req) || req.declaredWrite) return ALLOW;
    return deny('Write requests must come from a published playbook or action.');
  }
  if (req.service === 'exchange' || req.service === 'teams') {
    return req.cmdlet && /^Get-[A-Za-z]+$/.test(req.cmdlet)
      ? ALLOW
      : deny(`Only Get-* cmdlets run in read-only mode (requested ${req.cmdlet ?? 'none'}). Arm write access to continue.`);
  }
  if (req.service === 'runner') return req.declaredWrite ? deny('This script changes data. Arm write access to continue.') : ALLOW;
  if (SAFE.has(method)) return ALLOW;
  if (isReadPost(req)) return req.service === 'graph' && req.path === '/$batch' ? evaluateBatch(req.body) : ALLOW;
  return deny(`${method} ${req.path} changes data. Arm write access to continue.`);
}
