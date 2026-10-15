import { api, ApiRequestError } from '../lib/api';
import { parser, pick, rec, str } from './json';

/**
 * Show-once secrets (Temporary Access Passes, temporary passwords, new app secrets).
 *
 * - Live: the run SSE stream sends `{ type: 'secret', runId, stepId, stepPath, values: { field: value }, hints, producedAt }`
 *   as a message without an `id:` line (never replayed). For child runs (bulk, embedded playbooks) runId/stepPath name
 *   the child, but the message reaches the stream of the parent being watched.
 * - Replayed `log` events may carry `data.secret = { runId, stepId, stepPath, fields, hints, status }` with status
 *   delivered | held | sent | discarded. `held` means it is waiting for its person: GET
 *   /api/runs/:runId/secret/:stepPath (with the CSRF header — it consumes the secret) answers with the live shape once;
 *   a second call is 404 `secret_not_available`.
 * - Stored outputs mask them as `{ "$secret": true, "hint": "…" }`.
 *
 * Values live only in component memory: never in the React Query cache, storage or URLs.
 */

export interface SecretMessage {
  runId: string;
  stepId: string;
  stepPath: string;
  values: Record<string, string>;
  hints: Record<string, string>;
  /** A hint for the whole secret when the server sends a plain string. */
  note: string | null;
  producedAt: string | null;
}

export type SecretStatus = 'delivered' | 'held' | 'sent' | 'discarded';

export interface SecretNotice {
  runId: string;
  stepId: string;
  stepPath: string;
  fields: string[];
  status: SecretStatus;
}

export const secretKey = (s: { runId: string; stepPath: string }) => `${s.runId}:${s.stepPath}`;

function readHints(v: unknown): { hints: Record<string, string>; note: string | null } {
  if (typeof v === 'string') return { hints: {}, note: v };
  const hints: Record<string, string> = {};
  for (const [k, x] of Object.entries(rec(v))) if (typeof x === 'string') hints[k] = x;
  return { hints, note: null };
}

export function readSecretMessage(raw: unknown): SecretMessage | null {
  const o = rec(raw);
  const runId = pick(o, 'runId');
  const stepPath = pick(o, 'stepPath', 'path') ?? pick(o, 'stepId');
  const values: Record<string, string> = {};
  for (const [k, x] of Object.entries(rec(o.values)))
    if (typeof x === 'string' || typeof x === 'number') values[k] = String(x);
  if (!runId || !stepPath || Object.keys(values).length === 0) return null;
  const { hints, note } = readHints(o.hints);
  return { runId, stepId: pick(o, 'stepId') ?? stepPath, stepPath, values, hints, note, producedAt: pick(o, 'producedAt') ?? null };
}

export function readSecretNotice(raw: unknown): SecretNotice | null {
  const o = rec(raw);
  const runId = pick(o, 'runId');
  const stepPath = pick(o, 'stepPath', 'path') ?? pick(o, 'stepId');
  const status = o.status;
  if (!runId || !stepPath || (status !== 'delivered' && status !== 'held' && status !== 'sent' && status !== 'discarded')) return null;
  return {
    runId,
    stepId: pick(o, 'stepId') ?? stepPath,
    stepPath,
    fields: Array.isArray(o.fields) ? o.fields.filter((f): f is string => typeof f === 'string') : [],
    status,
  };
}

/** Each held secret is fetched at most once per page load (the fetch consumes it). */
const claimed = new Set<string>();

export type ClaimResult = { ok: true; secret: SecretMessage } | { ok: false; gone: boolean; message: string };

export async function claimHeldSecret(notice: Pick<SecretNotice, 'runId' | 'stepPath'>): Promise<ClaimResult | null> {
  const key = secretKey(notice);
  if (claimed.has(key)) return null;
  claimed.add(key);
  try {
    const secret = await api(`/api/runs/${encodeURIComponent(notice.runId)}/secret/${encodeURIComponent(notice.stepPath)}`, {
      csrf: true,
      schema: parser((input) => {
        const s = readSecretMessage({ runId: notice.runId, stepPath: notice.stepPath, ...rec(input) });
        if (!s) throw new TypeError('Expected { values }');
        return s;
      }),
    });
    return { ok: true, secret };
  } catch (e) {
    const gone = e instanceof ApiRequestError && (e.status === 404 || e.code === 'secret_not_available');
    return {
      ok: false,
      gone,
      message: gone ? 'This secret was already shown or has expired.' : ((e as Error).message ?? 'The secret could not be fetched.'),
    };
  }
}

/** Test hook: forget which secrets were claimed. */
export function __resetClaimedSecretsForTests() {
  claimed.clear();
}

// ── Masked values in stored outputs ────────────────────────────────────────────────────────────────

export interface SecretMask {
  $secret: true;
  hint?: string;
}

export const isSecretMask = (v: unknown): v is SecretMask =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { $secret?: unknown }).$secret === true;

export const maskText = (v: SecretMask) => `•••• ${str(v.hint) ?? ''}`.trim();

/** Deep copy for JSON views: masked secrets become "•••• <hint>". */
export function maskSecrets(value: unknown): unknown {
  if (isSecretMask(value)) return maskText(value);
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecrets(v)]));
  return value;
}

export const SHOWN_ONCE_TOOLTIP = 'Shown once to the person who ran this';
