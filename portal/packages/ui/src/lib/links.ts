/**
 * Link targets and Markdown text from content and tenant data. Shared by the widgets (markdown, actions) and the run
 * views (runbooks, manual steps, approvals) so every link in the portal follows one rule.
 */

/** Characters browsers silently remove from URLs (tabs, newlines, other controls): `/\t/host` would become `//host`. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * A link target the portal may render, or null. Allowed: `https://…` / `http://…` and `mailto:` (external, new tab),
 * in-app paths `/…` (but never `//host` or `/\host`, which browsers treat as another site) and `#anchors`.
 * Everything else — `javascript:`, `data:`, relative paths, anything with control characters — is refused.
 */
export function safeUrl(href: string): { href: string; external: boolean } | null {
  if (typeof href !== 'string' || !href || UNSAFE_CHARS.test(href)) return null;
  if (/^https?:\/\/[^/\\]/i.test(href)) return { href, external: true };
  if (/^mailto:[^/\\]/i.test(href)) return { href, external: true };
  if (/^\/(?![/\\])/.test(href)) return { href, external: false };
  if (href.startsWith('#')) return { href, external: false };
  return null;
}

/**
 * Follows a link target from content or data the one way the portal does: not at all (false) unless `safeUrl` allows
 * it; an external address — or any, with `newTab` — in a new tab without opener or referrer; an in-app one through
 * `navigate` (the router). The app's `useNavigateHref` and the widgets' content actions both go through it.
 */
export function followSafeUrl(
  href: unknown,
  navigate: (href: string) => void,
  opts: { newTab?: boolean } = {},
): boolean {
  const safe = typeof href === 'string' ? safeUrl(href) : null;
  if (!safe) return false;
  if (safe.external || opts.newTab) window.open(safe.href, '_blank', 'noopener,noreferrer');
  else navigate(safe.href);
  return true;
}

/**
 * Escapes a value placed into Markdown so it always shows as text: `[x](/admin)` can't become a link, `# x` can't
 * become a heading, `*x*` can't become emphasis. The portal's Markdown renderers undo these backslash escapes.
 * Keep in step with `escapeMarkdown` in @adminforge/engine (the server's copy).
 */
export function escapeMarkdown(value: string): string {
  return escapeMarkdownInline(value).replace(
    /(^|\n)([ \t]*)([#>+-]|\d+[.)])/g,
    (_m, nl: string, sp: string, mark: string) => `${nl}${sp}${mark.slice(0, -1)}\\${mark.slice(-1)}`,
  );
}

/**
 * Inline escapes only (links, emphasis, code): for text that keeps its own line structure on purpose — HTML from
 * Microsoft APIs turned into paragraphs and `- ` list items (widgets' htmlToText) — but must never form a link.
 */
export function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\`*_[\]()]/g, '\\$&');
}
