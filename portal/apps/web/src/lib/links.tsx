import { defaultParseSearch, Link, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { followSafeUrl, safeUrl, type LinkComponent } from '@adminforge/ui';

/** `/p/identity.users?userType=Guest` → path + parsed search (values typed the way the router reads them). */
export function splitHref(href: string): {
  pathname: string;
  search: Record<string, unknown>;
  hash?: string;
} {
  const [beforeHash = '', hash] = href.split('#', 2);
  const q = beforeHash.indexOf('?');
  const pathname = q >= 0 ? beforeHash.slice(0, q) : beforeHash;
  const search = q >= 0 ? (defaultParseSearch(beforeHash.slice(q)) as Record<string, unknown>) : {};
  return { pathname: pathname || '/', search, ...(hash ? { hash } : {}) };
}

/** `/p/<key>` → key; null for any other path, or a key that isn't valid percent-encoding (`/p/%E0`). */
export function contentKeyOf(pathname: string): string | null {
  const m = /^\/p\/([^/?#]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * The router's Link for any in-app href (content pages with their params, coded routes, the catch-all), and a plain
 * new-tab anchor for external links. Fits the `linkAs` / `Link` slots of ui primitives and widgets.
 *
 * Hrefs often come from content templates filled with tenant data, so only what `safeUrl` allows becomes a link:
 * anything else — `javascript:`, `//host` and `/\host` (which the router would render as an anchor the browser resolves
 * to another site), relative paths — shows its content as plain text.
 */
export const AppLink: LinkComponent = ({ href, className, children }) => {
  const safe = safeUrl(href);
  if (!safe) return <span className={className}>{children}</span>;
  if (safe.external)
    return (
      <a href={safe.href} className={className} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  const { pathname, search, hash } = splitHref(safe.href);
  const key = contentKeyOf(pathname);
  if (key)
    return (
      <Link to="/p/$key" params={{ key }} search={search as never} hash={hash} className={className}>
        {children}
      </Link>
    );
  // Coded routes (/runs, /admin/audit, …) and the catch-all resolve by path.
  return (
    <Link to={pathname as never} search={search as never} hash={hash} className={className}>
      {children}
    </Link>
  );
};

/**
 * Follows an href the way `AppLink` would (`followSafeUrl`): in-app through the router, external in a new tab, and
 * anything `safeUrl` refuses not at all (false). Row and menu actions navigate with hrefs templated from data.
 */
export function followHref(
  router: { navigate: (to: { href: string; replace?: boolean }) => unknown },
  href: string,
  opts?: { replace?: boolean },
): boolean {
  return followSafeUrl(href, (to) => void router.navigate({ href: to, replace: opts?.replace }));
}

/** Navigate to any safe href: in-app through the router, external in a new tab (`followHref`). */
export function useNavigateHref(): (href: string, opts?: { replace?: boolean }) => void {
  const router = useRouter();
  return useCallback(
    (href: string, opts?: { replace?: boolean }) => void followHref(router, href, opts),
    [router],
  );
}
