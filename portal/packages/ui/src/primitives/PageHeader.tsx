import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
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
  /**
   * `list`: for list pages, whose first rows should be above the fold — the actions on the title row and the
   * description as one line with "More" when it doesn't fit.
   */
  layout?: 'default' | 'list';
  className?: string;
}

/** The description on one line; "More" shows the rest when it doesn't fit (and "Less" folds it again). */
function OneLineSummary({ children }: { children: ReactNode }) {
  const s = pageHeader({ layout: 'list' });
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, children]);
  // More and Less sit in different places: keep keyboard focus on the one now shown.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [open]);
  const toggle = (
    <button
      ref={buttonRef}
      type="button"
      className={s.more()}
      aria-expanded={open}
      aria-controls={id}
      aria-label={open ? 'Show less of the description' : 'Show more of the description'}
      onClick={() => {
        refocus.current = true;
        setOpen((o) => !o);
      }}
    >
      {open ? 'Less' : 'More'}
    </button>
  );
  // Folded: one line as wide as the header, "More" at its end when it is cut off. Open: a readable measure with
  // "Less" right after the text.
  if (open)
    return (
      <p id={id} className={s.summaryText({ className: 'max-w-3xl' })}>
        {children} {toggle}
      </p>
    );
  return (
    <div className={s.summary()}>
      <p id={id} ref={ref} className={s.summaryText({ className: 'truncate' })}>
        {children}
      </p>
      {clipped && toggle}
    </div>
  );
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
  layout = 'default',
  className,
}: PageHeaderProps) {
  const s = pageHeader({ layout });
  if (layout === 'list')
    return (
      <header className={s.root({ className })}>
        {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} linkAs={linkAs} />}
        {eyebrow && <p className={s.eyebrow()}>{eyebrow}</p>}
        <div className={s.titleBar()}>
          <div className={s.titleRow()}>
            <h1 className={s.title()}>{title}</h1>
            {meta && <div className={s.meta()}>{meta}</div>}
          </div>
          {actions && (
            <div className={s.actions()} data-header-actions="">
              {actions}
            </div>
          )}
        </div>
        {description && <OneLineSummary>{description}</OneLineSummary>}
      </header>
    );
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
        {actions && (
          <div className={s.actions()} data-header-actions="">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
