const BASE = 'http://return-to.invalid';

/**
 * Only same-origin, path-absolute targets survive; everything else becomes `fallback`.
 * Rejects scheme-relative (`//evil`, also after dot-segment normalisation), backslash tricks (`/\evil`),
 * absolute URLs, control characters, and `/auth/*` (which would loop back into sign-in).
 */
export function safeReturnTo(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  // Dot segments are resolved by URL: '/.//evil.com' normalises to '//evil.com', which a browser reads as a host.
  if (url.pathname.startsWith('//')) return fallback;
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
