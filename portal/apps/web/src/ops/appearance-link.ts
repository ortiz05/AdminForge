import { useEffect } from 'react';

const LINK_ID = 'af-appearance';
export const APPEARANCE_CSS = '/api/appearance.css';

/**
 * Runtime token overrides (§6.8 step 6) are served as a stylesheet that must cascade after tokens.css. The app's
 * own CSS is already in <head> when the shell mounts, so appending this link last gives it the final word.
 * `version` busts the cache after a publish or rollback.
 */
export function loadAppearanceStylesheet(version?: string | number): void {
  if (typeof document === 'undefined') return;
  const href = version === undefined ? APPEARANCE_CSS : `${APPEARANCE_CSS}?v=${encodeURIComponent(String(version))}`;
  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    return;
  }
  if (link.getAttribute('href') !== href) link.href = href;
  // Keep it last even if other styles were injected since (lazy chunks in development).
  if (link !== document.head.lastElementChild) document.head.appendChild(link);
}

/** Loads the published appearance once the signed-in shell is up, and again whenever an admin publishes a change. */
export function useAppearanceStylesheet(): void {
  useEffect(() => {
    loadAppearanceStylesheet();
    let unsubscribe: (() => void) | undefined;
    let live = true;
    // The shared event stream loads after first paint (it isn't needed to render the shell).
    void import('../runs/event-stream').then(({ subscribePortalEvent }) => {
      if (!live) return;
      unsubscribe = subscribePortalEvent('appearance.changed', (data) => {
        const v = (data as { version?: unknown } | null)?.version;
        loadAppearanceStylesheet(typeof v === 'number' || typeof v === 'string' ? v : Date.now());
      });
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);
}
