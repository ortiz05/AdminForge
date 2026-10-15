import { useMemo } from 'react';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { Button, ErrorState } from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';

/**
 * What a page shows when it fails to load or crashes while rendering (router `defaultErrorComponent`). API failures
 * carry their own message, next step and reference; a rendering crash gets a local reference that is also logged to
 * the browser console, so a report can be matched up.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const local = useMemo(() => crypto.randomUUID(), []);
  if (error instanceof ApiRequestError) {
    return (
      <div className="p-6">
        <ErrorState
          title={error.status === 403 ? 'You don’t have access to this page' : 'This page couldn’t load'}
          message={error.message}
          hint={error.hint}
          code={error.code}
          correlationId={error.correlationId}
          action={<Button onClick={reset}>Try again</Button>}
        />
      </div>
    );
  }
  console.error(`AdminForge page error (reference ${local})`, error);
  return (
    <div className="p-6">
      <ErrorState
        title="This page hit a problem"
        message="AdminForge couldn’t display this page. Nothing was changed."
        hint="Try again, or reload the page. If it keeps happening, give a portal administrator the reference and what you were doing."
        correlationId={local}
        action={
          <div className="flex flex-wrap gap-2">
            <Button intent="primary" onClick={reset}>
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload the page</Button>
          </div>
        }
      />
    </div>
  );
}
