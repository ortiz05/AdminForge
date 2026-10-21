import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Brand, Kbd, MagnifyingGlassIcon, modKey, tv } from '@adminforge/ui';
import { PimIndicator } from './PimIndicator';
import type { MeResponse } from '@adminforge/schemas';

const rail = tv({
  slots: {
    root: 'af-rail fixed inset-x-0 top-0 z-(--af-z-drawer) flex items-center',
    brandZone: [
      'flex h-full shrink-0 items-center border-r border-line px-4 armed:border-on-armed/25',
      'w-(--af-layout-nav-w) transition-all duration-(--af-motion-base) nav-collapsed:w-(--af-layout-nav-w-collapsed) nav-collapsed:justify-center nav-collapsed:px-0',
    ],
    brandLink: 'rounded-md armed:text-on-armed',
    // Below `xl` the rail has no room for the tenant (the overview and the account menu name it): every control keeps
    // its place instead.
    tenant: 'flex min-w-0 shrink-0 flex-col justify-center pr-4 pl-5 leading-tight max-xl:hidden',
    tenantName: 'truncate text-sm font-semibold text-fg armed:text-on-armed',
    tenantDomain: 'truncate font-mono text-2xs text-fg-3 armed:text-on-armed',
    searchZone: 'flex min-w-0 flex-1 px-4 max-lg:px-2 max-sm:min-w-10 max-sm:px-1',
    search: [
      'mx-auto flex h-8 w-full max-w-md min-w-0 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 text-left text-fg-3',
      // A phone: a fixed 32 px icon button, never squeezed by the controls beside it.
      'max-sm:mx-0 max-sm:w-8 max-sm:shrink-0 max-sm:justify-center max-sm:px-0',
      'transition-colors duration-(--af-motion-fast) hover:border-line-strong hover:text-fg-2',
      'armed:border-on-armed/30 armed:bg-on-armed/10 armed:text-on-armed armed:hover:border-on-armed/60 armed:hover:text-on-armed',
    ],
    right: 'flex shrink-0 items-center gap-3 pr-3 pl-4 max-lg:gap-1.5 max-lg:pr-2 max-lg:pl-0',
    pim: [
      'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg-3 hover:bg-hover hover:text-fg-2 max-lg:px-1.5',
      'armed:text-on-armed armed:hover:bg-on-armed/15 armed:hover:text-on-armed',
    ],
    divider: 'h-6 w-px bg-line armed:bg-on-armed/25 max-lg:hidden',
  },
});

export interface SessionRailProps {
  me: MeResponse;
  onOpenPalette: () => void;
  armControl: ReactNode;
  userMenu: ReactNode;
  /** Status indicators before PIM (e.g. breaking news). */
  indicators?: ReactNode;
}

/**
 * The 48 px session rail: brand, tenant, jump-to, indicators (breaking news), PIM, mode (read / armed), and you. It fits
 * every width down to a 390 px phone: below `xl` there is no tenant, below `lg` (where the navigation starts collapsed)
 * the controls show their short form (see each one) and below `sm` jump-to is a 32 px icon button.
 */
export function SessionRail({ me, onOpenPalette, armControl, userMenu, indicators }: SessionRailProps) {
  const s = rail();
  return (
    <header className={s.root()}>
      <div className={s.brandZone()}>
        <Link to="/" className={s.brandLink()} aria-label="AdminForge home">
          <span className="nav-collapsed:hidden">
            <Brand size="sm" rail />
          </span>
          <span className="hidden nav-collapsed:inline">
            <Brand size="sm" compact rail />
          </span>
        </Link>
      </div>
      <div className={s.tenant()}>
        <span className={s.tenantName()}>{me.tenant.name}</span>
        <span className={s.tenantDomain()}>{me.tenant.domain}</span>
      </div>
      <div className={s.searchZone()}>
        <button
          type="button"
          className={s.search()}
          onClick={onOpenPalette}
          aria-keyshortcuts="Control+K Meta+K"
        >
          <MagnifyingGlassIcon size={15} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm max-sm:sr-only">Jump to a page or action…</span>
          {/* No shortcut to show on a phone, and the hint would run into the indicators beside it. */}
          <Kbd keys={[modKey(), 'K']} className="armed:opacity-80 max-sm:hidden" />
        </button>
      </div>
      <div className={s.right()}>
        {indicators}
        <PimIndicator className={s.pim()} />
        <span className={s.divider()} aria-hidden />
        {armControl}
        <span className={s.divider()} aria-hidden />
        {userMenu}
      </div>
    </header>
  );
}
