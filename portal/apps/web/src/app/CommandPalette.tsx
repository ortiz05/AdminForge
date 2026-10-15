import { useMemo, useState } from 'react';
import type { NavItem, NavSection } from '@adminforge/schemas';
import {
  ClockIcon,
  CommandGroup,
  CommandItem,
  CommandPalette as Palette,
  ArrowSquareOutIcon,
  Icon,
  LightningIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
  RowsIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  XIcon,
} from '@adminforge/ui';
import { splitHref, useNavigateHref } from '../lib/links';
import { isNavCollapsed, pushRecent, updatePrefs, usePrefs } from '../lib/prefs';
import { SEARCH_SECTIONS, useSearch, type SearchResult } from '../lib/search';
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

/** One server search hit: in-app pages navigate, Microsoft portal deep links open in a new tab. */
function ResultItem({
  r,
  icon,
  search,
  onGo,
}: {
  r: SearchResult;
  icon: string;
  search: string;
  onGo: (href: string) => void;
}) {
  return (
    <CommandItem
      value={`search ${r.type} ${r.href} ${r.title}`}
      // Server results already match the query; keep cmdk from filtering them out on fuzzy differences.
      keywords={[search]}
      icon={<Icon name={r.icon ?? icon} size={16} />}
      hint={
        <span className="inline-flex items-center gap-1">
          {r.subtitle}
          {r.external && <ArrowSquareOutIcon size={12} aria-label="Opens in a new tab" />}
        </span>
      }
      onSelect={() => onGo(r.href)}
    >
      {r.title}
    </CommandItem>
  );
}

/** Ctrl/⌘K: jump to pages (from /api/nav), recent pages, directory/Azure search (GET /api/search), and shell actions. */
export function CommandPalette({ open, onOpenChange, sections, canArm }: CommandPaletteProps) {
  const navigateHref = useNavigateHref();
  const prefs = usePrefs();
  const shell = useShell();
  const [search, setSearch] = useState('');
  const found = useSearch(open ? search : '');

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
    if (!/^https?:\/\//.test(href)) pushRecent(splitHref(href).pathname);
    navigateHref(href);
  };
  // Content pages already listed under Pages aren't repeated from the server search.
  const navHrefs = new Set(pages.map((p) => p.item.href));
  const results = found.results.filter((r) => !navHrefs.has(r.href));
  const act = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <Palette
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      placeholder="Jump to a page, user, group, device or resource…"
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
      {SEARCH_SECTIONS.map((sec) => {
        const hits = results.filter((r) => sec.types.includes(r.type));
        return hits.length ? (
          <CommandGroup key={sec.heading} heading={sec.heading}>
            {hits.map((r) => (
              <ResultItem key={`${r.type}:${r.href}`} r={r} icon={sec.icon} search={search} onGo={go} />
            ))}
          </CommandGroup>
        ) : null;
      })}
      {found.error && results.length === 0 && (
        <CommandGroup heading="Directory and Azure">
          <CommandItem
            value={`search status ${search}`}
            keywords={[search]}
            disabled
            icon={<MagnifyingGlassIcon size={16} />}
          >
            Directory search didn’t respond — pages and actions still work
          </CommandItem>
        </CommandGroup>
      )}
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
          onSelect={act(() => updatePrefs({ navCollapsed: !isNavCollapsed(prefs) }))}
        >
          {isNavCollapsed(prefs) ? 'Expand navigation' : 'Collapse navigation'}
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
