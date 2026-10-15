import type { ReactNode } from 'react';
import { ApiRequestError } from './api';

/** Plain text for any thrown error: the API's message and next step, or a general line (never a raw exception). */
export function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) return e.hint ? `${e.message} ${e.hint}` : e.message;
  return 'AdminForge couldn’t complete this. Try again; if it keeps happening, reload the page.';
}

/** Toast or callout body: what happened, what to do, and the reference to give a portal administrator. */
export function errorDescription(e: unknown): ReactNode {
  const ref = e instanceof ApiRequestError ? e.correlationId : undefined;
  return (
    <>
      {errorText(e)}
      {ref && <span className="mt-1 block font-mono text-xs text-fg-3">Reference {ref}</span>}
    </>
  );
}
