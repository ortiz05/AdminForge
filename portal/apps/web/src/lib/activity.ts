/**
 * Is the person at the browser using the page right now? The BFF slides the session's idle timeout only for requests
 * the person caused; everything the tab does on its own (polling, refetches on focus or reconnect, refetches after a
 * server event, retries) is sent as background (`X-AdminForge-Background: 1`, see `api()`), so an unattended tab
 * doesn't keep a session alive.
 *
 * A request counts as the person's when they interacted with the page (pointer, key, wheel, back/forward) within the
 * last few seconds, or the page has just loaded. That covers every poller without each one having to say so, and
 * an unattended tab can never send a request that counts as activity.
 */

/** How recently the person must have interacted for a request to count as theirs. */
export const ACTIVITY_WINDOW_MS = 10_000;

/** Deliberate interactions only: a passing mouse pointer or a focus change isn't someone using the page. */
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'popstate'] as const;

// Loading (or reloading) the page is the person's doing.
let lastActivity = Date.now();

export function noteActivity(at: number = Date.now()): void {
  lastActivity = at;
}

/** True when the person interacted with the page within the activity window. */
export function isUserActive(now: number = Date.now()): boolean {
  return now - lastActivity < ACTIVITY_WINDOW_MS;
}

/** Listens for interactions on `target` (capture phase, so widgets that stop propagation still count); returns a cleanup. */
export function trackActivity(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const note = () => noteActivity();
  for (const type of EVENTS) target.addEventListener(type, note, { capture: true, passive: true });
  return () => {
    for (const type of EVENTS) target.removeEventListener(type, note, { capture: true });
  };
}
