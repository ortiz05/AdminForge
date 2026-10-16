/**
 * Masking for everything the live suite and scripts print. Live output reports statuses, codes and counts; any
 * free text that reaches the terminal or a log — an error message from the portal, Microsoft or Playwright, a URL —
 * goes through `mask` (text) or `maskError` / `why` (error-like values) first, so tenant identifiers never leave the
 * process: object and tenant ids (GUIDs), e-mail addresses and UPNs, and the tenant's own Microsoft domains.
 *
 * Inputs: any string, or any error-like value (`Error`, `{ code, message }`, a string, a portal response's
 * `error`). Outputs: one line of masked text. Used by every script in tests/live/scripts, lib/runs.ts,
 * lib/portal-session.ts, lib/entra-login.ts and e2e/portal.live.spec.ts; tested in tests/unit/live/mask.test.ts.
 */

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/**
 * `local@domain`, with or without a TLD (Exchange sometimes names a mailbox `alias@tenant`); a full stop after the
 * address stays outside the match.
 */
const ADDRESS = /[^\s@<>"',;()[\]]+@[^\s@<>"',;()[\]]*[^\s@<>"',;()[\].]/g;
/** The tenant's initial domain and SharePoint hosts: `contoso.onmicrosoft.com`, `contoso-admin.sharepoint.com`. */
const TENANT_HOST = /\b[a-z0-9][a-z0-9-]*\.(onmicrosoft\.com|sharepoint\.com)\b/gi;

/** `text` with GUIDs as `<id>`, addresses and UPNs as `<address>`, tenant hosts as `<tenant>.onmicrosoft.com` / … */
export const mask = (text: string): string =>
  text.replace(GUID, '<id>').replace(ADDRESS, '<address>').replace(TENANT_HOST, '<tenant>.$1');

export interface MaskErrorOptions {
  /** Longest message kept, after masking (default 300). */
  max?: number;
  /** Keep only the first sentence of the message (Microsoft errors explain at length). */
  firstSentence?: boolean;
}

/**
 * One masked line for an error-like value: `<code>: <message>`, `<code>`, or `<message>`, with the message masked and
 * cut to `max` characters. Never JSON-dumps an object (it could carry ids, inputs or response bodies).
 */
export function maskError(err: unknown, opts: MaskErrorOptions = {}): string {
  const max = opts.max ?? 300;
  let code: string | undefined;
  let message: string | undefined;
  if (typeof err === 'string') message = err;
  else if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string' || typeof e.code === 'number') code = String(e.code);
    if (typeof e.message === 'string') message = e.message;
  }
  if (message && opts.firstSentence) message = message.split(/(?<=\.)\s/)[0] ?? message;
  const text = message ? mask(message.replace(/\s+/g, ' ').trim()).slice(0, max) : '';
  if (code && text) return `${mask(code)}: ${text}`;
  return code ? mask(code) : text || 'error';
}

/** ` — <code>: <masked message>` for a failed run, step or request (the suffix of a status line), or ''. */
export function why(err: unknown, opts?: MaskErrorOptions): string {
  if (!err || (typeof err === 'object' && !('code' in err) && !('message' in err))) return '';
  return ` — ${maskError(err, opts)}`;
}

/** A URL without its query and fragment, masked (sign-in URLs carry the tenant id in the path). */
export const maskUrl = (url: string): string => mask(url.replace(/[?#].*/, ''));
