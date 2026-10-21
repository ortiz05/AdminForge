import { Link, useRouterState } from '@tanstack/react-router';
import type { NavItem, NavSection } from '@adminforge/schemas';
import {
  CaretDoubleLeftIcon,
  CaretDoubleRightIcon,
  CaretDownIcon,
  cn,
  Icon,
  LockKeyIcon,
  Skeleton,
  STATUS_ICON,
  Tooltip,
  tv,
} from '@adminforge/ui';
import { contentKeyOf, splitHref } from '../lib/links';
import { checksText, useSectionChecks, type SectionCheck } from './section-checks';

const nav = tv({
  slots: {
    root: [
      'fixed top-(--af-layout-rail-h) bottom-(--af-layout-dock-h) left-0 z-(--af-z-dock) flex flex-col border-r border-line bg-panel',
      'w-(--af-layout-nav-w) transition-all duration-(--af-motion-base) ease-(--af-motion-ease) nav-collapsed:w-(--af-layout-nav-w-collapsed)',
    ],
    scroll:
      'flex min-h-0 flex-1 flex-col gap-1 overflow-x-hidden overflow-y-auto px-3 py-4 nav-collapsed:gap-4 nav-collapsed:px-2',
    section: 'flex flex-col gap-0.5',
    /** The section's row: its toggle (or label) and, when it has probes, its check status at the end. */
    headingRow: 'flex min-w-0 items-center',
    /** A group label that doesn't toggle anything: the eyebrow style is kept for those. */
    heading: 'af-eyebrow flex h-6 min-w-0 flex-1 items-center gap-2 px-2 nav-collapsed:sr-only',
    /** Section rows toggle their section (not in the icon rail, where headings are hidden): full size, like a page. */
    headingToggle: [
      'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md pr-1.5 pl-2 text-left text-md font-semibold text-fg-2',
      'transition-colors duration-(--af-motion-fast) hover:bg-hover hover:text-fg',
    ],
    caret: 'shrink-0 text-fg-3 transition-transform duration-(--af-motion-fast)',
    hiddenCount: 'text-xs font-normal text-fg-3 tabular-nums',
    /** The section's open pages, set off from the next section's row. */
    list: 'flex flex-col gap-0.5 pb-2 nav-collapsed:pb-0',
    /** Check status: a dot when healthy, a ring with no result yet, the status glyph when degraded or failing. */
    check: [
      'inline-flex size-6 shrink-0 items-center justify-center rounded-sm',
      'transition-colors duration-(--af-motion-fast) hover:bg-hover',
    ],
    checkActive: 'bg-selected hover:bg-selected',
    checkSlot: 'size-6 shrink-0',
    item: [
      'group flex h-(--af-control-h) min-w-0 items-center gap-2.5 rounded-md px-2 text-fg-2',
      'transition-colors duration-(--af-motion-fast) hover:bg-hover hover:text-fg',
      'nav-collapsed:justify-center nav-collapsed:px-0',
    ],
    itemActive: 'af-nav-active bg-selected font-medium text-fg hover:bg-selected',
    itemIcon: 'shrink-0 text-fg-3 group-hover:text-fg-2',
    label: 'min-w-0 flex-1 truncate nav-collapsed:sr-only',
    badge: 'rounded-pill bg-accent-subtle px-1.5 text-2xs font-semibold text-accent nav-collapsed:hidden',
    /** Live counts (unread news): a pill beside the label, a bubble on the icon in the icon rail. */
    count:
      'min-w-5 rounded-pill bg-accent px-1.5 text-center text-2xs leading-4 font-semibold text-on-accent tabular-nums nav-collapsed:hidden',
    countDot: [
      'absolute top-0.5 right-1 hidden h-3.5 min-w-3.5 items-center justify-center rounded-pill bg-accent px-0.5',
      'text-2xs leading-none font-semibold text-on-accent tabular-nums nav-collapsed:flex',
    ],
    /** "Requires Intune": the page still opens (and explains), so it's a quiet lock, not an alert. */
    requires:
      'inline-flex max-w-24 shrink-0 items-center gap-1 rounded-sm border border-line px-1 text-2xs font-medium text-fg-3 nav-collapsed:hidden',
    requiresDot:
      'absolute top-1 right-1 hidden size-3 items-center justify-center text-fg-3 nav-collapsed:flex',
    divider: 'mx-2 hidden h-px bg-line nav-collapsed:block',
    foot: 'border-t border-line p-2',
    toggle: [
      'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-3 hover:bg-hover hover:text-fg',
      'nav-collapsed:justify-center nav-collapsed:px-0',
    ],
  },
});

/**
 * Whether a nav item is the current place. An item whose href carries a query (`/monitoring?group=exchange`) is active
 * only while the URL has those values; the plain item for the same path (`/monitoring`) then isn't, so exactly one item
 * is highlighted. `others` are the rail's other hrefs.
 */
export function isActive(
  href: string,
  pathname: string,
  search: Record<string, unknown> = {},
  others: readonly string[] = [],
): boolean {
  const target = splitHref(href);
  const path = target.pathname;
  const onPath = path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
  if (!onPath) return false;
  const matches = (q: Record<string, unknown>) =>
    Object.entries(q).every(([k, v]) => search[k] !== undefined && String(search[k]) === String(v));
  if (Object.keys(target.search).length) return matches(target.search);
  return !others.some((other) => {
    const o = splitHref(other);
    return o.pathname === path && Object.keys(o.search).length > 0 && matches(o.search);
  });
}

/** Short names for licences, service plans and feature keys as they appear in "Requires …" badges. */
const SHORT: Array<[RegExp, string]> = [
  [/^(intune|intune_a|intune_edu|intune_smbiz|ems)$/i, 'Intune'],
  [/^(aad_premium_p2|entrap2|pim|identityprotection)$/i, 'Entra P2'],
  [/^(aad_premium|entrap1|conditionalaccess|signinlogs)$/i, 'Entra P1'],
  [/^(exchange|exchange_s_\w+)$/i, 'Exchange'],
  [/^(teams|teams1)$/i, 'Teams'],
  [/^(sharepoint|sharepoint\w*)$/i, 'SharePoint'],
  [/^(defenderendpoint|tvm_premium_1|.*defender for endpoint plan 2.*)$/i, 'Defender for Endpoint'],
  [/^(defender\w*|windefatp|mde_\w+|atp_enterprise|threat_intelligence|mtp)$/i, 'Defender'],
];

const shortName = (s: string) => SHORT.find(([re]) => re.test(s))?.[1];

/**
 * "Requires INTUNE_A or EMS" → "Intune"; "Requires Microsoft Intune Plan 1 (INTUNE_A)" → "Intune" (the service plan in
 * parentheses names it when the words don't); null for count badges like "3".
 */
export function requiresText(badge: string | undefined): string | null {
  const m = badge ? /^requires\s+(.+)$/i.exec(badge.trim()) : null;
  if (!m) return null;
  const names = m[1]!.split(/\s+or\s+|,\s*/).map((part) => {
    const text = part.trim();
    const plan = /\(?([A-Za-z0-9_]+)\)?$/.exec(text)?.[1];
    return shortName(text) ?? (plan ? shortName(plan) : undefined) ?? text;
  });
  return [...new Set(names)].join(' / ');
}

/** A live count on a navigation item: `count` is shown ("99+" above 99), `label` is what it means. */
export interface NavCount {
  count: number;
  /** "12 unread changes" — the accessible description and the icon-rail tooltip. */
  label: string;
}

const countText = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * The rail decides what's current (`isActive`). TanStack would also mark `/monitoring` current on
 * `/monitoring?group=…` (it matches search partially) and set `aria-current` itself; exact matching leaves it to us.
 */
const EXACT = { exact: true } as const;

function NavLink({
  item,
  section,
  active,
  collapsed,
  live,
}: {
  item: NavItem;
  section: NavSection;
  active: boolean;
  collapsed: boolean;
  live?: NavCount;
}) {
  const s = nav();
  const requires = requiresText(item.badge);
  const counted = live && live.count > 0 ? live : undefined;
  const className = cn(s.item(), active && s.itemActive(), (requires || counted) && 'relative');
  const content = (
    <>
      <Icon
        name={item.icon ?? section.icon}
        size={18}
        weight={active ? 'fill' : 'regular'}
        className={cn(s.itemIcon(), active && 'text-accent group-hover:text-accent')}
      />
      <span className={cn(s.label(), requires && !active && 'text-fg-3')}>{item.label}</span>
      {requires ? (
        <>
          <span className={s.requires()} title={item.badge}>
            <LockKeyIcon size={10} weight="bold" aria-hidden className="shrink-0" />
            <span className="truncate">{requires}</span>
          </span>
          <span className={s.requiresDot()} aria-hidden>
            <LockKeyIcon size={10} weight="bold" />
          </span>
          <span className="sr-only">({item.badge})</span>
        </>
      ) : (
        item.badge && <span className={s.badge()}>{item.badge}</span>
      )}
      {counted && (
        <>
          <span className={s.count()} aria-hidden>
            {countText(counted.count)}
          </span>
          <span className={s.countDot()} aria-hidden>
            {countText(counted.count)}
          </span>
          {/* The space keeps "News and changes (3 unread changes)" apart in the accessible name. */}{' '}
          <span className="sr-only">({counted.label})</span>
        </>
      )}
    </>
  );
  const external = /^https?:\/\//.test(item.href);
  const { pathname, search } = splitHref(item.href);
  const key = contentKeyOf(pathname);
  const current = active ? ('page' as const) : undefined;
  const link = external ? (
    <a href={item.href} target="_blank" rel="noreferrer" className={className}>
      {content}
    </a>
  ) : key ? (
    <Link
      to="/p/$key"
      params={{ key }}
      search={search as never}
      className={className}
      aria-current={current}
      activeOptions={EXACT}
    >
      {content}
    </Link>
  ) : (
    // Coded routes (/runs, /admin/audit, …) and the catch-all resolve by path.
    <Link
      to={pathname as never}
      search={search as never}
      className={className}
      aria-current={current}
      activeOptions={EXACT}
    >
      {content}
    </Link>
  );
  return (
    <Tooltip
      content={
        requires ? `${item.label} · ${item.badge}` : counted ? `${item.label} · ${counted.label}` : item.label
      }
      side="right"
      disabled={!collapsed}
    >
      {link}
    </Tooltip>
  );
}

/** Dot when healthy, ring with no result yet, the status glyph (warning, cross) when degraded or failing. */
function CheckGlyph({ status }: { status: SectionCheck['status'] }) {
  if (status === 'crit' || status === 'warn') {
    const Glyph = STATUS_ICON[status];
    return (
      <Glyph size={14} weight="fill" aria-hidden className={status === 'crit' ? 'text-crit' : 'text-warn'} />
    );
  }
  return (
    <span
      className={cn('size-2 rounded-pill', status === 'ok' ? 'bg-ok' : 'border border-fg-3')}
      aria-hidden
    />
  );
}

/**
 * The section's check status at the end of its row, linking to Synthetic monitoring for the section's own probes
 * (`/monitoring?group=<key>`). Never colour alone: the shape differs per state (dot, ring, warning, cross) and the
 * link's name and tooltip say it in words.
 */
function SectionCheckLink({
  section,
  check,
  active,
}: {
  section: NavSection;
  check: SectionCheck;
  active: boolean;
}) {
  const s = nav();
  const text = checksText(check);
  return (
    <Tooltip content={`Service checks · ${text}`} side="right">
      <Link
        to="/monitoring"
        search={{ group: section.key } as never}
        activeOptions={EXACT}
        className={cn(s.check(), active && s.checkActive())}
        aria-label={`${section.label} service checks: ${text}`}
        aria-current={active ? 'page' : undefined}
        data-status={check.status}
      >
        <CheckGlyph status={check.status} />
      </Link>
    </Tooltip>
  );
}

export interface NavRailProps {
  sections: NavSection[] | undefined;
  loading?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Keys of closed sections (by default all of them). A closed section still shows the page you're on and any page with
   * a live count (unread news), so nothing that needs attention disappears.
   */
  closedSections?: readonly string[];
  onToggleSection?: (key: string) => void;
  /** Live counts by navigation item key (e.g. `news`: unread changes). */
  counts?: Readonly<Record<string, NavCount>>;
}

/**
 * Sections and pages from GET /api/nav, collapsible to a 56 px icon rail. Section rows open and close their section
 * and, when the section has probes, end with its check status (a link to `/monitoring?group=<key>`); the icon rail
 * always shows every page (its headings and check status are hidden).
 */
export function NavRail({
  sections,
  loading,
  collapsed,
  onToggle,
  closedSections = [],
  onToggleSection,
  counts,
}: NavRailProps) {
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const search = useRouterState({ select: (st) => st.location.search }) as Record<string, unknown>;
  const checks = useSectionChecks();
  const checkHref = (key: string) => `/monitoring?group=${key}`;
  // A section's check view (/monitoring?group=…) is its dot's place, not Synthetic monitoring's.
  const hrefs = [
    ...(sections?.flatMap((x) => x.items.map((i) => i.href)) ?? []),
    ...(sections ?? []).filter((x) => checks?.[x.key]).map((x) => checkHref(x.key)),
  ];
  const active = (href: string) => isActive(href, pathname, search, hrefs);
  const s = nav();
  return (
    <nav aria-label="Primary" className={s.root()}>
      <div className={s.scroll()}>
        {loading &&
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 px-2">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-36 nav-collapsed:w-8" />
              <Skeleton className="h-4 w-28 nav-collapsed:w-8" />
            </div>
          ))}
        {sections?.map((section, i) => {
          const closed = !collapsed && closedSections.includes(section.key);
          const items = closed
            ? section.items.filter((item) => active(item.href) || counts?.[item.key])
            : section.items;
          const hidden = section.items.length - items.length;
          // In the icon rail headings are hidden, and so is the check status (Synthetic monitoring has every probe).
          const check = collapsed ? undefined : checks?.[section.key];
          // Only when some section has checks does every row keep the status column, so the carets line up.
          const status = check ? (
            <SectionCheckLink section={section} check={check} active={active(checkHref(section.key))} />
          ) : checks && Object.keys(checks).length > 0 && !collapsed ? (
            <span className={s.checkSlot()} aria-hidden />
          ) : null;
          return (
            <div key={section.key} className={s.section()}>
              {i > 0 && <div className={s.divider()} aria-hidden />}
              <div className={s.headingRow()}>
                {collapsed || !onToggleSection ? (
                  <h2 className={s.heading()} id={`nav-${section.key}`}>
                    {section.label}
                  </h2>
                ) : (
                  <h2 className="min-w-0 flex-1 nav-collapsed:sr-only" id={`nav-${section.key}`}>
                    <button
                      type="button"
                      className={s.headingToggle()}
                      aria-expanded={!closed}
                      aria-controls={`nav-list-${section.key}`}
                      aria-label={closed ? `${section.label} (${hidden} pages hidden)` : section.label}
                      onClick={() => onToggleSection(section.key)}
                    >
                      <span className="min-w-0 flex-1 truncate" title={section.label}>
                        {section.label}
                      </span>
                      {closed && hidden > 0 && (
                        <span className={s.hiddenCount()} aria-hidden>
                          {hidden}
                        </span>
                      )}
                      <CaretDownIcon
                        size={12}
                        weight="bold"
                        aria-hidden
                        className={cn(s.caret(), closed && '-rotate-90')}
                      />
                    </button>
                  </h2>
                )}
                {status}
              </div>
              {/* Always in the DOM so the heading's aria-controls resolves; hidden when nothing in it is shown. */}
              <ul
                id={`nav-list-${section.key}`}
                aria-labelledby={`nav-${section.key}`}
                className={s.list()}
                hidden={items.length === 0}
              >
                {items.map((item) => (
                  <li key={item.key}>
                    <NavLink
                      item={item}
                      section={section}
                      active={active(item.href)}
                      collapsed={collapsed}
                      live={counts?.[item.key]}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <div className={s.foot()}>
        <button
          type="button"
          className={s.toggle()}
          onClick={onToggle}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <CaretDoubleRightIcon size={16} aria-hidden />
          ) : (
            <CaretDoubleLeftIcon size={16} aria-hidden />
          )}
          <span className="nav-collapsed:sr-only">Collapse</span>
        </button>
      </div>
    </nav>
  );
}
