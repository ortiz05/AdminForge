import { defaultParseSearch, Link, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { LinkComponent } from '@adminforge/ui';

export const isExternalHref = (href: string) => /^(https?:|mailto:)/i.test(href);

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

/** `/p/<key>` → key. */
export function contentKeyOf(pathname: string): string | null {
  const m = /^\/p\/([^/?#]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The router's Link for any in-app href (content pages with their params, coded routes, the catch-all), and a plain
 * new-tab anchor for external links. Fits the `linkAs` / `Link` slots of ui primitives and widgets.
 */
export const AppLink: LinkComponent = ({ href, className, children }) => {
  if (isExternalHref(href))
    return (
      <a href={href} className={className} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  const { pathname, search, hash } = splitHref(href);
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

/** Navigate to any href: in-app through the router, external in a new tab. */
export function useNavigateHref(): (href: string, opts?: { replace?: boolean }) => void {
  const router = useRouter();
  return useCallback(
    (href: string, opts?: { replace?: boolean }) => {
      if (isExternalHref(href)) {
        window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      void router.navigate({ href, replace: opts?.replace });
    },
    [router],
  );
}
