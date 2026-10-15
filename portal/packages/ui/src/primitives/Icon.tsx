import { createElement, useEffect, useState } from 'react';
import type { IconWeight } from '@phosphor-icons/react';

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

export interface IconProps {
  /** Phosphor name from content: "shield-check" or "ShieldCheck". */
  name: string | undefined;
  size?: number;
  weight?: IconWeight;
  className?: string;
  /** Icons are decorative unless given a label. */
  label?: string;
}

/** An icon named by content (navigation, pages, playbooks). Unknown names fall back to a neutral glyph. */
export function Icon({ name, size = 16, weight = 'regular', className, label }: IconProps) {
  const [loaded, setLoaded] = useState<Registry | null>(registry);
  useEffect(() => {
    if (loaded) return;
    let live = true;
    void loadIcons().then((m) => live && setLoaded(m));
    return () => {
      live = false;
    };
  }, [loaded]);
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  if (!loaded)
    return (
      <span
        {...a11y}
        className={className}
        style={{ display: 'inline-block', width: size, height: size, flexShrink: 0 }}
      />
    );
  return createElement(loaded.resolveIcon(name), { size, weight, className, ...a11y });
}
