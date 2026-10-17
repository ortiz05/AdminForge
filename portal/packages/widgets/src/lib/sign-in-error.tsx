import type { ReactNode } from 'react';
import { Button } from '@adminforge/ui';
import type { WidgetError, WidgetRuntime } from '../types';

/**
 * How a widget shows a `reauth` error (Microsoft wants a fresh sign-in): "Sign in again" instead of a "Try again" that
 * would fail the same way — or, when the page already shows its one sign-in banner, a quiet note instead of the error.
 */
export interface SignInErrorView {
  /** The page's banner covers it: show a neutral note, no error and no button. */
  quiet: boolean;
  /** "Sign in again" when the error carries a login URL and the runtime can start a sign-in. */
  action?: ReactNode;
}

export function signInErrorView(
  error: WidgetError | undefined,
  runtime: WidgetRuntime,
): SignInErrorView | null {
  if (error?.code !== 'reauth') return null;
  if (runtime.signInBanner) return { quiet: true };
  const login = error.login;
  const signIn = runtime.signIn;
  return {
    quiet: false,
    action:
      login && signIn ? (
        <Button size="sm" intent="primary" onClick={() => signIn(login)}>
          Sign in again
        </Button>
      ) : undefined,
  };
}

/** Copy for the quiet note under a page's sign-in banner. */
export const signInNote = (label: string) => ({
  title: `Sign in again to see ${label.toLowerCase()}`,
  body: 'Use “Sign in again” at the top of the page.',
});
