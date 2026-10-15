import type { ComponentType, ReactNode } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { pageHeader } from '../recipes/page-header';

export interface Crumb {
  label: string;
  href?: string;
}

export type LinkComponent = ComponentType<{ href: string; className?: string; children: ReactNode }>;

const PlainLink: LinkComponent = ({ href, className, children }) => (
  <a href={href} className={className}>
    {children}
  </a>
);

export function Breadcrumbs({
  items,
  linkAs: Link = PlainLink,
  className,
}: {
  items: Crumb[];
  linkAs?: LinkComponent;
  className?: string;
}) {
  const s = pageHeader();
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className={s.crumbs()}>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1">
              {c.href && !last ? (
                <Link href={c.href} className={s.crumb()}>
                  {c.label}
                </Link>
              ) : (
                <span className={last ? s.current() : undefined} aria-current={last ? 'page' : undefined}>
                  {c.label}
                </span>
              )}
              {!last && <CaretRightIcon size={10} weight="bold" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Chips beside the title (IdChip, StatusPill). */
  meta?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  linkAs?: LinkComponent;
  className?: string;
}

/** Every page starts here: where you are, what this is, what you can do. */
export function PageHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
  breadcrumbs,
  linkAs,
  className,
}: PageHeaderProps) {
  const s = pageHeader();
  return (
    <header className={s.root({ className })}>
      {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} linkAs={linkAs} />}
      <div className={s.row()}>
        <div className={s.heading()}>
          {eyebrow && <p className={s.eyebrow()}>{eyebrow}</p>}
          <div className={s.titleRow()}>
            <h1 className={s.title()}>{title}</h1>
            {meta && <div className={s.meta()}>{meta}</div>}
          </div>
          {description && <p className={s.description()}>{description}</p>}
        </div>
        {actions && <div className={s.actions()}>{actions}</div>}
      </div>
    </header>
  );
}
