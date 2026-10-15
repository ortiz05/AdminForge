import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { iconModules } from './icon-glob';

/**
 * Any Phosphor glyph by name, loaded on demand. The bundler turns this glob into one small chunk per glyph, and
 * nothing loads until content asks for a name the curated registry doesn't have (so `siren`, `server`,
 * `microsoft-teams-logo` all work without shipping ~1,500 icons up front).
 */
const modules = iconModules as Record<string, () => Promise<Record<string, PhosphorIcon>>>;

export const normaliseIconName = (name: string) =>
  name
    .replace(/Icon$/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

const LOADERS = new Map<string, { exportName: string; load: () => Promise<Record<string, PhosphorIcon>> }>();
for (const [path, load] of Object.entries(modules)) {
  const file = /([A-Za-z0-9]+)\.es\.js$/.exec(path)?.[1];
  if (file) LOADERS.set(normaliseIconName(file), { exportName: `${file}Icon`, load });
}

const loaded = new Map<string, PhosphorIcon | null>();
const pending = new Map<string, Promise<PhosphorIcon | null>>();

/** The glyph if it has already been loaded (null = no such icon), undefined if not tried yet. */
export function cachedPhosphorIcon(name: string): PhosphorIcon | null | undefined {
  return loaded.get(normaliseIconName(name));
}

/**
 * Loads one Phosphor glyph by kebab-case or PascalCase name; resolves null for unknown names. A failed chunk load is
 * retried once and never cached, so a transient failure doesn't pin the fallback glyph for the session.
 */
export function loadPhosphorIcon(name: string): Promise<PhosphorIcon | null> {
  const key = normaliseIconName(name);
  if (loaded.has(key)) return Promise.resolve(loaded.get(key)!);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const entry = LOADERS.get(key);
  if (!entry) {
    loaded.set(key, null);
    return Promise.resolve(null);
  }
  const p = entry
    .load()
    .catch(() => entry.load())
    .then(
      (m) => {
        const icon = m[entry.exportName] ?? null;
        loaded.set(key, icon);
        return icon;
      },
      () => null,
    )
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Number of glyphs available on demand (for tests). */
export const phosphorIconCount = () => LOADERS.size;
