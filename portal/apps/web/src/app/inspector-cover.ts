/**
 * Does the inspector cover the list beside it? The inspector is `inspector-wide-factor` × `inspector-w` wide, but
 * never over the navigation rail (design tokens, `--af-layout-inspector-wide-w` and its collapsed-rail twin). When that
 * leaves less than MIN_LIST_BESIDE_INSPECTOR_REM of the list visible, the sliver isn't usable: the inspector covers the
 * list instead (a light scrim that closes it, the page inert) rather than sharing the screen. On wide screens it stays
 * non-modal: rows beside it remain clickable and switch what it shows.
 */
import { useSyncExternalStore } from 'react';
import { scale } from '@adminforge/design-tokens';
import { useHtmlAttribute } from '@adminforge/ui';

/** Enough for the list's first column (a name and its sign-in line): rows beside the drawer stay clickable. */
export const MIN_LIST_BESIDE_INSPECTOR_REM = 16;

const px = (value: string) => Number.parseFloat(value);

/** The inspector's width in px for a viewport and rail state — the CSS token's formula on the token values. */
export function inspectorWidthPx(viewport: number, navCollapsed: boolean): number {
  const { layout } = scale;
  const nav = px(navCollapsed ? layout['nav-w-collapsed'] : layout['nav-w']);
  return Math.min(Number(layout['inspector-wide-factor']) * px(layout['inspector-w']), viewport - nav);
}

/** True when the list would keep less than MIN_LIST_BESIDE_INSPECTOR_REM beside the inspector. */
export function inspectorCoversList(viewport: number, navCollapsed: boolean, remPx = 16): boolean {
  const nav = px(navCollapsed ? scale.layout['nav-w-collapsed'] : scale.layout['nav-w']);
  return viewport - nav - inspectorWidthPx(viewport, navCollapsed) < MIN_LIST_BESIDE_INSPECTOR_REM * remPx;
}

function subscribeResize(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** `inspectorCoversList` for this window and the rail's current state (`data-nav`, set by the shell). */
export function useInspectorCoversList(): boolean {
  const width = useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 0,
  );
  const nav = useHtmlAttribute('data-nav');
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return inspectorCoversList(width, nav === 'collapsed', rem);
}
