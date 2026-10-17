/**
 * At most one automatic trip to sign-in per tab in a short window.
 *
 * `api()` sends the browser to sign in when a request the person made answers 401 with a login URL, and the round
 * trip comes back to the same address (deep links included). When the answer after a fresh sign-in is again 401 —
 * a sign-in that can't satisfy what Microsoft asks for, or a read that keeps answering `reauth` — following it again
 * would loop: single sign-on completes silently, the page reloads, the same request fails, and the tab spins through
 * sign-in forever. So a second automatic redirect within the window is not taken: the request fails with its error
 * (and the login URL), and the screen offers "Sign in again" instead (AppShell, error states).
 *
 * The time of the last automatic redirect lives in sessionStorage (per tab, survives the round trip). Without
 * storage (private mode, blocked) nothing is remembered and every redirect is taken, as before.
 */

const KEY = 'af.signin.redirectedAt';

/** How long after an automatic sign-in redirect another one is held back. */
export const SIGN_IN_REDIRECT_WINDOW_MS = 60_000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function session(): Store | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** False when an automatic sign-in redirect already happened within the window (the next one would loop). */
export function maySignInAutomatically(
  now: number = Date.now(),
  store: Store | undefined = session(),
): boolean {
  try {
    const last = Number(store?.getItem(KEY));
    return !(Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < SIGN_IN_REDIRECT_WINDOW_MS);
  } catch {
    return true;
  }
}

/** Records an automatic sign-in redirect (call right before leaving for sign-in). */
export function noteAutomaticSignIn(now: number = Date.now(), store: Store | undefined = session()): void {
  try {
    store?.setItem(KEY, String(now));
  } catch {
    // Storage full or blocked: the guard just doesn't remember this one.
  }
}
