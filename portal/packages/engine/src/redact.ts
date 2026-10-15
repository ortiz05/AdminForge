import type { Params } from '@adminforge/schemas';

/**
 * Redaction for anything persisted or shown: step requests, plan bodies, audit details, run views.
 * Keys that name credentials are always redacted; values of inputs declared `redact: true` are redacted wherever
 * they appear.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_KEY =
  /pass(word|phrase)?$|secret|token|credential(?!s?Type)|^key$|apikey|authorization|cookie|signature|private|^pin$|otp$|temporaryAccessPass/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** Deep copy with sensitive keys and `secrets` values replaced by `[redacted]`. */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  const needles = secrets.filter((s) => s.length >= 4);
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 32) return '[truncated]';
    if (typeof v === 'string') return needles.some((n) => v.includes(n)) ? REDACTED : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v))
        out[k] =
          SENSITIVE_KEY.test(k) && x !== null && x !== undefined && typeof x !== 'boolean'
            ? REDACTED
            : walk(x, depth + 1);
      return out;
    }
    return v;
  };
  return walk(value, 0);
}

/** String values of inputs whose param is declared `redact: true`. */
export function secretInputValues(params: Params | undefined, inputs: Record<string, unknown>): string[] {
  if (!params) return [];
  const out: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    if (!p.redact) continue;
    const v = inputs[name];
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
  }
  return out;
}

/** Inputs for display/audit: `redact: true` params replaced, sensitive keys redacted. */
export function redactInputs(
  params: Params | undefined,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) out[k] = params?.[k]?.redact ? REDACTED : v;
  return redact(out) as Record<string, unknown>;
}

const utf8 = new TextEncoder();

/** JSON size in bytes (UTF-8), or Infinity when not serialisable. */
export function jsonBytes(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : utf8.encode(s).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface TruncatedOutput {
  $truncated: true;
  bytes: number;
  preview: string;
}

export const isTruncated = (v: unknown): v is TruncatedOutput => isPlainObject(v) && v.$truncated === true;

/** Output as stored: whole when ≤ maxBytes, else a marker with a preview (§7.8: ≤ 256 KB per step). */
export function storableOutput(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return null;
  const bytes = jsonBytes(value);
  if (bytes <= maxBytes) return value;
  let preview: string;
  try {
    preview = (JSON.stringify(value) ?? '').slice(0, 4096);
  } catch {
    preview = String(value).slice(0, 4096);
  }
  return { $truncated: true, bytes, preview } satisfies TruncatedOutput;
}
