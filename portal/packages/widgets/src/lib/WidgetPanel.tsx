import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  FlaskIcon,
  Panel,
  ProvenanceFooter,
  Skeleton,
  cn,
} from '@adminforge/ui';
import type { WidgetData, WidgetRuntime } from '../types';
import { ActionButton } from './actions';
import { signInErrorView, signInNote } from './sign-in-error';
import type { EmptySpec } from './schema-common';

export interface WidgetPanelProps {
  config: { title?: string; description?: string; empty?: EmptySpec };
  data: WidgetData;
  runtime: WidgetRuntime;
  /** Name used in messages when the block has no title ("Sign-ins didn’t load"). */
  name: string;
  /** Ready, but nothing to show. */
  isEmpty?: boolean;
  /** Default empty copy when content gives none (§6.9: invite action). */
  emptyDefault: { title: string; body?: string };
  flush?: boolean;
  actions?: ReactNode;
  /** Extra footer content, right of the provenance line (Load more). */
  footer?: ReactNode;
  skeleton?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

function DefaultSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="w-3/4" />
      <Skeleton className="w-1/2" />
      <Skeleton className="w-2/3" />
    </div>
  );
}

/**
 * The frame every data widget shares: Panel header, loading skeleton, error and empty states with the copy rules
 * (§6.9), and the provenance footer (`graph · /users · 1.2 s · cached 30 s ago`).
 */
export function WidgetPanel({
  config,
  data,
  runtime,
  name,
  isEmpty,
  emptyDefault,
  flush,
  actions,
  footer,
  skeleton,
  className,
  bodyClassName,
  children,
}: WidgetPanelProps) {
  const title = config.title;
  const label = title ?? name;
  const signIn = data.status === 'error' ? signInErrorView(data.error, runtime) : null;
  let body: ReactNode;
  if (data.status === 'loading' || data.status === 'idle') {
    body = (
      <div className={cn(flush && 'px-(--af-pad-panel) pb-(--af-pad-panel)')} aria-busy="true">
        {skeleton ?? <DefaultSkeleton />}
        <span className="sr-only">Loading {label.toLowerCase()}</span>
      </div>
    );
  } else if (data.status === 'error' && data.error?.code === 'licence_required') {
    // Not a failure: the tenant lacks a licence. Explain it in the same neutral voice as the page licence gate.
    body = (
      <EmptyState compact title={`${label} needs a licence your tenant doesn’t have`}>
        {data.error.message}
        {data.error.hint ? ` ${data.error.hint}` : ''}
      </EmptyState>
    );
  } else if (data.status === 'error' && signIn?.quiet) {
    const note = signInNote(label);
    body = (
      <EmptyState compact title={note.title}>
        {note.body}
      </EmptyState>
    );
  } else if (data.status === 'error') {
    const err = data.error ?? { message: 'The data source returned an error.' };
    body = (
      <ErrorState
        compact
        title={`${label} didn’t load`}
        message={err.message}
        hint={err.hint}
        code={err.code}
        correlationId={err.correlationId}
        action={
          signIn
            ? signIn.action
            : data.retry && (
                <Button size="sm" onClick={data.retry}>
                  Try again
                </Button>
              )
        }
      />
    );
  } else if (isEmpty) {
    const e = config.empty;
    body = (
      <EmptyState
        compact
        title={e?.title ?? emptyDefault.title}
        action={
          e?.action && <ActionButton action={e.action} scope={runtime.scope} runtime={runtime} size="sm" />
        }
      >
        {e?.body ?? emptyDefault.body}
      </EmptyState>
    );
  } else {
    body = children;
  }

  const provenance = data.provenance ? <ProvenanceFooter {...data.provenance} /> : null;
  const showFooter = Boolean(provenance || (footer && data.status === 'ready'));
  return (
    <Panel
      title={title}
      description={config.description}
      flush={flush}
      className={className}
      bodyClassName={bodyClassName}
      aria-label={title ? undefined : name}
      actions={
        (actions || data.preview) && (
          <>
            {data.preview && (
              <Badge tone="outline" title="Sample data — this tenant lacks the licence for live data">
                <FlaskIcon size={11} aria-hidden />
                Sample data
              </Badge>
            )}
            {actions}
          </>
        )
      }
      footer={
        showFooter && (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">{provenance}</div>
            {data.status === 'ready' && footer}
          </div>
        )
      }
    >
      {body}
    </Panel>
  );
}
