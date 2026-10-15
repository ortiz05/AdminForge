import { Link, useRouterState } from '@tanstack/react-router';
import type { NavItem, NavSection } from '@adminforge/schemas';
import { CaretDoubleLeftIcon, CaretDoubleRightIcon, cn, Icon, LockKeyIcon, Skeleton, Tooltip, tv } from '@adminforge/ui';
import { contentKeyOf, splitHref } from '../lib/links';

const nav = tv({
  slots: {
    root: [
      'fixed top-(--af-layout-rail-h) bottom-(--af-layout-dock-h) left-0 z-(--af-z-dock) flex flex-col border-r border-line bg-panel',
      'w-(--af-layout-nav-w) transition-all duration-(--af-motion-base) ease-(--af-motion-ease) nav-collapsed:w-(--af-layout-nav-w-collapsed)',
    ],
    scroll:
      'flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 py-4 nav-collapsed:px-2',
    section: 'flex flex-col gap-0.5',
    heading: 'af-eyebrow flex h-6 items-center gap-2 px-2 nav-collapsed:sr-only',
    item: [
      'group flex h-(--af-control-h) min-w-0 items-center gap-2.5 rounded-md px-2 text-fg-2',
      'transition-colors duration-(--af-motion-fast) hover:bg-hover hover:text-fg',
      'nav-collapsed:justify-center nav-collapsed:px-0',
    ],
    itemActive: 'af-nav-active bg-selected font-medium text-fg hover:bg-selected',
    itemIcon: 'shrink-0 text-fg-3 group-hover:text-fg-2',
    label: 'min-w-0 flex-1 truncate nav-collapsed:sr-only',
    badge: 'rounded-pill bg-accent-subtle px-1.5 text-2xs font-semibold text-accent nav-collapsed:hidden',
    /** "Requires Intune": the page still opens (and explains), so it's a quiet lock, not an alert. */
    requires:
      'inline-flex max-w-24 shrink-0 items-center gap-1 rounded-sm border border-line px-1 text-2xs font-medium text-fg-3 nav-collapsed:hidden',
    requiresDot: 'absolute top-1 right-1 hidden size-3 items-center justify-center text-fg-3 nav-collapsed:flex',
    divider: 'mx-2 hidden h-px bg-line nav-collapsed:block',
    foot: 'border-t border-line p-2',
    toggle: [
      'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-3 hover:bg-hover hover:text-fg',
      'nav-collapsed:justify-center nav-collapsed:px-0',
    ],
  },
});

export function isActive(href: string, pathname: string): boolean {
  const path = splitHref(href).pathname;
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Short names for licences, service plans and feature keys as they appear in "Requires …" badges. */
const SHORT: Array<[RegExp, string]> = [
  [/^(intune|intune_a|intune_edu|intune_smbiz|ems)$/i, 'Intune'],
  [/^(aad_premium_p2|entrap2|pim|identityprotection)$/i, 'Entra P2'],
  [/^(aad_premium|entrap1|conditionalaccess|signinlogs)$/i, 'Entra P1'],
  [/^(exchange|exchange_s_\w+)$/i, 'Exchange'],
  [/^(teams|teams1)$/i, 'Teams'],
  [/^(sharepoint|sharepoint\w*)$/i, 'SharePoint'],
  [/^(defender\w*|windefatp|mde_\w+|atp_enterprise|threat_intelligence|mtp)$/i, 'Defender'],
];

/** "Requires INTUNE_A or EMS" → "Intune"; null for count badges like "3". */
export function requiresText(badge: string | undefined): string | null {
  const m = badge ? /^requires\s+(.+)$/i.exec(badge.trim()) : null;
  if (!m) return null;
  const names = m[1]!.split(/\s+or\s+|,\s*/).map((part) => SHORT.find(([re]) => re.test(part.trim()))?.[1] ?? part.trim());
  return [...new Set(names)].join(' / ');
}

function NavLink({
  item,
  section,
  active,
  collapsed,
}: {
  item: NavItem;
  section: NavSection;
  active: boolean;
  collapsed: boolean;
}) {
  const s = nav();
  const requires = requiresText(item.badge);
  const className = cn(s.item(), active && s.itemActive(), requires && 'relative');
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
    <Link to="/p/$key" params={{ key }} search={search as never} className={className} aria-current={current}>
      {content}
    </Link>
  ) : (
    // Coded routes (/runs, /admin/audit, …) and the catch-all resolve by path.
    <Link to={pathname as never} search={search as never} className={className} aria-current={current}>
      {content}
    </Link>
  );
  return (
    <Tooltip content={requires ? `${item.label} · ${item.badge}` : item.label} side="right" disabled={!collapsed}>
      {link}
    </Tooltip>
  );
}

export interface NavRailProps {
  sections: NavSection[] | undefined;
  loading?: boolean;
  collapsed: boolean;
  onToggle: () => void;
}

/** Sections and pages from GET /api/nav, collapsible to a 56 px icon rail. */
export function NavRail({ sections, loading, collapsed, onToggle }: NavRailProps) {
  const pathname = useRouterState({ select: (st) => st.location.pathname });
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
        {sections?.map((section, i) => (
          <div key={section.key} className={s.section()}>
            {i > 0 && <div className={s.divider()} aria-hidden />}
            <h2 className={s.heading()} id={`nav-${section.key}`}>
              {section.label}
            </h2>
            <ul aria-labelledby={`nav-${section.key}`} className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.key}>
                  <NavLink
                    item={item}
                    section={section}
                    active={isActive(item.href, pathname)}
                    collapsed={collapsed}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
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
