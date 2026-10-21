import {
  Avatar,
  Badge,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  SignOutIcon,
} from '@adminforge/ui';
import { themeMeta, THEME_NAMES } from '@adminforge/design-tokens';
import type { MeResponse } from '@adminforge/schemas';
import { updatePrefs, usePrefs, type DensityPref, type ThemePref } from '../lib/prefs';

export const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  ...THEME_NAMES.map((t) => ({ value: t as ThemePref, label: themeMeta[t].label })),
  { value: 'system', label: 'Match system' },
];

export const DENSITY_OPTIONS: Array<{ value: DensityPref; label: string }> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

/** Who you are, how AdminForge looks for you, and sign out. */
export function UserMenu({ me, onSignOut }: { me: MeResponse; onSignOut: () => void }) {
  const prefs = usePrefs();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account and appearance: ${me.user.name}`}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-pill hover:bg-hover armed:hover:bg-on-armed/15 max-lg:size-8"
        >
          <Avatar name={me.user.name} />
        </button>
      </MenuTrigger>
      <MenuContent className="w-64">
        <div className="flex flex-col gap-1 px-2 pt-2 pb-2.5">
          <span className="truncate text-sm font-semibold text-fg">{me.user.name}</span>
          <span className="truncate font-mono text-2xs text-fg-3">{me.user.upn}</span>
          {/* The session rail names the tenant from `xl`; narrower, it's here. */}
          <span className="mt-1 truncate text-xs text-fg-2 xl:hidden">
            {me.tenant.name} · <span className="font-mono text-2xs text-fg-3">{me.tenant.domain}</span>
          </span>
          {me.roles.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {me.roles.map((r) => (
                <Badge key={r} tone="outline">
                  {r.replace(/^Portal\./, '')}
                </Badge>
              ))}
            </span>
          )}
        </div>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup
          value={prefs.theme ?? 'system'}
          onValueChange={(v) => updatePrefs({ theme: v as ThemePref })}
        >
          {THEME_OPTIONS.map((o) => (
            <MenuRadioItem key={o.value} value={o.value} onSelect={(e) => e.preventDefault()}>
              {o.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>Density</MenuLabel>
        <MenuRadioGroup
          value={prefs.density ?? 'comfortable'}
          onValueChange={(v) => updatePrefs({ density: v as DensityPref })}
        >
          {DENSITY_OPTIONS.map((o) => (
            <MenuRadioItem key={o.value} value={o.value} onSelect={(e) => e.preventDefault()}>
              {o.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<SignOutIcon size={16} />} onSelect={onSignOut}>
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
