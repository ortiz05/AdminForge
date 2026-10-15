import { createElement, useEffect, useState } from 'react';
import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react';

type Registry = typeof import('./icon-registry');

let registry: Registry | null = null;
let pending: Promise<Registry> | null = null;

/**
 * Loads the content icon set (its own chunk, so ~60 glyphs stay out of the first load).
 * Navigation data arrives over the network anyway, so icons are ready by the time it renders.
 */
export function loadIcons(): Promise<Registry> {
  pending ??= import('./icon-registry').then((m) => (registry = m));
  return pending;
}

// Glyphs outside the curated set load one by one; the loader (and its ~1,500-entry map) is itself a lazy chunk.
const extra = new Map<string, PhosphorIcon | null>();
const extraKey = (name: string) => name.replace(/Icon$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
function loadExtra(name: string): Promise<PhosphorIcon | null> {
  return import('./icon-loader')
    .then(async (m) => {
      const icon = await m.loadPhosphorIcon(name);
      // Only definite answers are remembered (a glyph, or a name Phosphor doesn't have).
      if (icon || m.cachedPhosphorIcon(name) === null) extra.set(extraKey(name), icon);
      return icon;
    })
    .catch(() => null);
}

export interface IconProps {
  /** Phosphor name from content: "shield-check" or "ShieldCheck". */
  name: string | undefined;
  size?: number;
  weight?: IconWeight;
  className?: string;
  /** Icons are decorative unless given a label. */
  label?: string;
}

/**
 * An icon named by content (navigation, pages, playbooks). The curated set loads in one chunk; any other Phosphor
 * name loads on demand as its own small chunk. Unknown names fall back to a neutral glyph.
 */
export function Icon({ name, size = 16, weight = 'regular', className, label }: IconProps) {
  const [loaded, setLoaded] = useState<Registry | null>(registry);
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (loaded) return;
    let live = true;
    void loadIcons().then((m) => live && setLoaded(m));
    return () => {
      live = false;
    };
  }, [loaded]);
  const curated = loaded ? loaded.findIcon(name) : undefined;
  const other = loaded && name && !curated ? extra.get(extraKey(name)) : undefined;
  // A chunk that failed to load shows the neutral glyph (and is retried on the next mount).
  const [failed, setFailed] = useState<string | null>(null);
  const waiting = Boolean(loaded && name && !curated && other === undefined && failed !== name);
  useEffect(() => {
    if (!waiting || !name) return;
    let live = true;
    void loadExtra(name).then((icon) => {
      if (!live) return;
      if (icon || extra.has(extraKey(name))) setVersion((v) => v + 1);
      else setFailed(name);
    });
    return () => {
      live = false;
    };
  }, [waiting, name]);
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  if (!loaded)
    return (
      <span
        {...a11y}
        className={className}
        style={{ display: 'inline-block', width: size, height: size, flexShrink: 0 }}
      />
    );
  // A glyph outside the curated set is loading: hold its space with the (invisible) neutral glyph.
  if (waiting)
    return createElement(loaded.resolveIcon(undefined), { size, weight, className, ...a11y, style: { visibility: 'hidden' } });
  return createElement(curated ?? other ?? loaded.resolveIcon(undefined), { size, weight, className, ...a11y });
}
