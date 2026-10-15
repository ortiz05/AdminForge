import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_DENSITY, DEFAULT_THEME, type ThemeName } from '@adminforge/design-tokens';
import type { UserPrefs } from '@adminforge/schemas';
import { api } from './api';

/** Same key and shape public/theme-init.js reads before the app boots. */
export const PREFS_KEY = 'adminforge.prefs';

export type ThemePref = NonNullable<UserPrefs['theme']>;
export type DensityPref = NonNullable<UserPrefs['density']>;

const THEMES: readonly ThemePref[] = ['steel', 'daylight', 'contrast', 'system'];
const DENSITIES: readonly DensityPref[] = ['comfortable', 'compact'];

function sanitize(input: unknown): UserPrefs {
  const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return {
    theme: THEMES.includes(p.theme as ThemePref) ? (p.theme as ThemePref) : undefined,
    density: DENSITIES.includes(p.density as DensityPref) ? (p.density as DensityPref) : undefined,
    navCollapsed: typeof p.navCollapsed === 'boolean' ? p.navCollapsed : undefined,
    navSections: Array.isArray(p.navSections)
      ? p.navSections.filter((x): x is string => typeof x === 'string').slice(0, 30)
      : undefined,
    pinned: Array.isArray(p.pinned)
      ? p.pinned.filter((x): x is string => typeof x === 'string').slice(0, 50)
      : undefined,
    recents: Array.isArray(p.recents)
      ? p.recents.filter((x): x is string => typeof x === 'string').slice(0, 50)
      : undefined,
  };
}

const strip = (p: UserPrefs): UserPrefs =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as UserPrefs;

export function readLocalPrefs(): UserPrefs {
  try {
    return strip(sanitize(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')));
  } catch {
    return {};
  }
}

const media = (q: string) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;

/** Organisation defaults (Admin → Appearance) for people without a preference; set when the session loads. */
let orgDefaults: { theme?: ThemePref; density?: DensityPref } = {};
export function setOrgDefaults(d: { theme?: ThemePref; density?: DensityPref } | undefined): void {
  orgDefaults = d ?? {};
}

/** Own choice, else the organisation default, else the OS ("system": high contrast first, then light/dark). */
export function resolveTheme(theme: ThemePref | undefined): ThemeName {
  if (theme && theme !== 'system') return theme;
  if (!theme && orgDefaults.theme && orgDefaults.theme !== 'system') return orgDefaults.theme;
  if (media('(prefers-contrast: more)')) return 'contrast';
  if (media('(prefers-color-scheme: light)')) return 'daylight';
  return DEFAULT_THEME;
}

/** Below this width the navigation starts collapsed (public/theme-init.js uses the same query). */
export const NARROW_NAV_QUERY = '(max-width: 1023px)';

/** The person's own choice, else collapsed in narrow windows. The rail's width and its toggle both use this. */
export function isNavCollapsed(p: UserPrefs): boolean {
  return p.navCollapsed ?? media(NARROW_NAV_QUERY);
}

/** Sets the <html> attributes every token selector keys off. */
export function applyPrefs(p: UserPrefs, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = resolveTheme(p.theme);
  root.dataset.density = p.density ?? orgDefaults.density ?? DEFAULT_DENSITY;
  root.dataset.nav = isNavCollapsed(p) ? 'collapsed' : 'expanded';
}

// A tiny external store so the user menu, palette and nav share one source of truth.
let current: UserPrefs = typeof window === 'undefined' ? {} : readLocalPrefs();
const listeners = new Set<() => void>();
let saveTimer: number | undefined;

function emit() {
  for (const l of listeners) l();
}

function persistLocal(p: UserPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(strip(p)));
  } catch {
    // Storage full or blocked: the server copy still applies on next sign-in.
  }
}

function scheduleSave(p: UserPrefs) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api('/api/me/prefs', { method: 'PUT', body: strip(p) }).catch(() => {
      // Preferences are a convenience; a failed save keeps the local copy and is retried on the next change.
    });
  }, 400);
}

export function getPrefs(): UserPrefs {
  return current;
}

/** Change preferences: applied immediately, mirrored to localStorage, saved to the server (debounced). */
export function updatePrefs(patch: Partial<UserPrefs>, { save = true }: { save?: boolean } = {}): void {
  current = strip({ ...current, ...patch });
  applyPrefs(current);
  persistLocal(current);
  emit();
  if (save) scheduleSave(current);
}

/** Server preferences win over the local copy when the session loads. */
export function hydratePrefs(server: UserPrefs | undefined): void {
  if (!server || Object.keys(strip(server)).length === 0) {
    applyPrefs(current);
    return;
  }
  updatePrefs(server, { save: false });
}

/** Remembers a visited page for the command palette. */
export function pushRecent(href: string): void {
  const recents = [href, ...(current.recents ?? []).filter((r) => r !== href)].slice(0, 12);
  updatePrefs({ recents });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrefs(): UserPrefs {
  const prefs = useSyncExternalStore(subscribe, getPrefs, getPrefs);
  // "Match system" keeps following the OS while the app is open.
  useEffect(() => {
    if (prefs.theme !== 'system' && prefs.theme !== undefined) return;
    if (typeof window.matchMedia !== 'function') return;
    const queries = ['(prefers-color-scheme: light)', '(prefers-contrast: more)'].map((q) =>
      window.matchMedia(q),
    );
    const onChange = () => applyPrefs(getPrefs());
    queries.forEach((q) => q.addEventListener('change', onChange));
    return () => queries.forEach((q) => q.removeEventListener('change', onChange));
  }, [prefs.theme]);
  return prefs;
}

/** Test seam: reset the in-memory store. */
export function __resetPrefsForTests(next: UserPrefs = {}): void {
  current = next;
  emit();
}
