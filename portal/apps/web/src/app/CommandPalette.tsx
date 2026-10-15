import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { NavItem, NavSection } from '@adminforge/schemas';
import {
  ClockIcon,
  CommandGroup,
  CommandItem,
  CommandPalette as Palette,
  Icon,
  LightningIcon,
  PaletteIcon,
  RowsIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  XIcon,
} from '@adminforge/ui';
import { pushRecent, updatePrefs, usePrefs } from '../lib/prefs';
import { DENSITY_OPTIONS, THEME_OPTIONS } from './UserMenu';
import { useShell } from './shell-context';

/** Pages that exist outside content navigation. */
export const BUILT_IN_PAGES: NavItem[] = [
  { key: 'design', label: 'Design system', href: '/design', icon: 'Palette' },
];

interface PaletteEntry {
  item: NavItem;
  section: string;
  icon?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: NavSection[] | undefined;
  canArm: boolean;
}

/** Ctrl/⌘K: jump to pages (from /api/nav), recent pages, and shell actions. */
export function CommandPalette({ open, onOpenChange, sections, canArm }: CommandPaletteProps) {
  const navigate = useNavigate();
  const prefs = usePrefs();
  const shell = useShell();
  const [search, setSearch] = useState('');

  const pages: PaletteEntry[] = useMemo(
    () => [
      ...(sections ?? []).flatMap((s) =>
        s.items.map((item) => ({ item, section: s.label, icon: item.icon ?? s.icon })),
      ),
      ...BUILT_IN_PAGES.map((item) => ({ item, section: 'AdminForge', icon: item.icon })),
    ],
    [sections],
  );
  const recents = (prefs.recents ?? [])
    .map((href) => pages.find((p) => p.item.href === href))
    .filter((p): p is PaletteEntry => Boolean(p))
    .slice(0, 5);

  const close = () => {
    onOpenChange(false);
    setSearch('');
  };
  const go = (href: string) => {
    close();
    pushRecent(href);
    if (/^https?:\/\//.test(href)) window.open(href, '_blank', 'noreferrer');
    else if (href === '/') void navigate({ to: '/' });
    else void navigate({ to: '/$', params: { _splat: href.replace(/^\//, '') } });
  };
  const act = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <Palette
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      placeholder="Jump to a page, or type an action like “theme”…"
      search={search}
      onSearchChange={setSearch}
      footer={
        <>
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>Esc to close</span>
        </>
      }
    >
      {!search && recents.length > 0 && (
        <CommandGroup heading="Recent">
          {recents.map((p) => (
            <CommandItem
              key={`recent-${p.item.href}`}
              value={`recent ${p.item.href}`}
              keywords={[p.item.label]}
              icon={<ClockIcon size={16} />}
              hint={p.section}
              onSelect={() => go(p.item.href)}
            >
              {p.item.label}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      <CommandGroup heading="Pages">
        {pages.map((p) => (
          <CommandItem
            key={`page-${p.item.key}-${p.item.href}`}
            value={`${p.item.label} ${p.section} ${p.item.href}`}
            icon={<Icon name={p.icon} size={16} />}
            hint={p.section}
            onSelect={() => go(p.item.href)}
          >
            {p.item.label}
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandGroup heading="Actions">
        {canArm && !shell.arm.armed && (
          <CommandItem
            value="Arm write access"
            keywords={['write', 'armed', 'elevate']}
            icon={<LightningIcon size={16} />}
            onSelect={act(shell.openArmDialog)}
          >
            Arm write access…
          </CommandItem>
        )}
        {shell.arm.canExtend && (
          <CommandItem
            value="Extend write access"
            icon={<LightningIcon size={16} />}
            onSelect={act(() => void shell.extend())}
          >
            Extend write access
          </CommandItem>
        )}
        {shell.arm.armed && (
          <CommandItem
            value="Disarm write access"
            keywords={['read-only', 'end']}
            icon={<XIcon size={16} />}
            onSelect={act(() => void shell.disarm())}
          >
            Disarm write access
          </CommandItem>
        )}
        {THEME_OPTIONS.map((o) => (
          <CommandItem
            key={`theme-${o.value}`}
            value={`Theme ${o.label}`}
            keywords={['appearance', 'colour', 'color', 'dark', 'light']}
            icon={<PaletteIcon size={16} />}
            hint={prefs.theme === o.value || (!prefs.theme && o.value === 'system') ? 'Current' : undefined}
            onSelect={act(() => updatePrefs({ theme: o.value }))}
          >
            Switch theme: {o.label}
          </CommandItem>
        ))}
        {DENSITY_OPTIONS.map((o) => (
          <CommandItem
            key={`density-${o.value}`}
            value={`Density ${o.label}`}
            keywords={['rows', 'spacing']}
            icon={<RowsIcon size={16} />}
            hint={(prefs.density ?? 'comfortable') === o.value ? 'Current' : undefined}
            onSelect={act(() => updatePrefs({ density: o.value }))}
          >
            Density: {o.label}
          </CommandItem>
        ))}
        <CommandItem
          value="Toggle navigation"
          keywords={['sidebar', 'collapse', 'expand']}
          icon={<SidebarSimpleIcon size={16} />}
          onSelect={act(() => updatePrefs({ navCollapsed: !prefs.navCollapsed }))}
        >
          {prefs.navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        </CommandItem>
        <CommandItem
          value="Sign out"
          icon={<SignOutIcon size={16} />}
          onSelect={act(() => void shell.signOut())}
        >
          Sign out
        </CommandItem>
      </CommandGroup>
    </Palette>
  );
}
