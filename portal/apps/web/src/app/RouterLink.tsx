import { Link } from '@tanstack/react-router';
import type { LinkComponent } from '@adminforge/ui';

/** Adapts the router's Link to the `linkAs` slot of ui primitives (breadcrumbs, empty-state actions). */
export const RouterLink: LinkComponent = ({ href, className, children }) =>
  /^https?:\/\//.test(href) ? (
    <a href={href} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : href === '/' ? (
    <Link to="/" className={className}>
      {children}
    </Link>
  ) : (
    <Link to="/$" params={{ _splat: href.replace(/^\//, '') }} className={className}>
      {children}
    </Link>
  );
