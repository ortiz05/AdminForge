import { Component, createRef, Fragment, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import {
  ArrowClockwiseIcon,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  FlaskIcon,
  IdChip,
  Kpi,
  Panel,
  ProvenanceFooter,
  Skeleton,
  Tooltip,
  cn,
} from '@adminforge/ui';
import type { WidgetData, WidgetProps, WidgetRuntime } from '../types';
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

/** What a block without a name of its own is called in messages (never its widget type). */
export const UNNAMED_BLOCK = 'This part of the page';

/**
 * The title of a block that can't be shown — it crashed while rendering, or its definition doesn't validate: one
 * wording everywhere, by the name the page gives the block ("Profile couldn’t be shown"), else "This part of the
 * page couldn’t be shown". Never the widget type.
 */
export function cantBeShownTitle(label: string | undefined): string {
  return `${label || UNNAMED_BLOCK} couldn’t be shown`;
}

/** A reference for a crash in the browser (no server request to carry one): shown, and logged with the error. */
function localReference(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

interface BoundaryProps {
  /** The block's title or KPI label: "Sign-ins couldn’t be shown" (none: "This part of the page …"). */
  label?: string;
  /** New data clears the error and renders the block again. */
  resetKey: unknown;
  /**
   * Where the fallback stands: `panel` — in a panel of its own (the whole block failed); `body` — inside the panel it
   * replaces the content of; `cell` — a figure in a KPI strip, shaped like the strip's other cells.
   */
  layout: 'panel' | 'body' | 'cell';
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
  reference?: string;
  resetKey?: unknown;
  /** Try again was pressed since the last new data (announces the outcome, keeps focus on a retry that failed). */
  retried?: boolean;
}

/**
 * One block's crash stays in that block. A value no widget expected (hostile or malformed tenant data) would
 * otherwise throw while rendering and the router's error view would replace the whole `/p/<key>` page for everyone
 * who opens it. The block says it couldn't be shown, with a local reference (logged to the browser console with the
 * error, so a report can be matched up) and Try again; new data renders it again by itself. Never the error text or
 * a stack trace.
 */
export class WidgetBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };
  private readonly retryButton = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true, reference: localReference() };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { resetKey: props.resetKey, failed: false, retried: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `AdminForge widget error (reference ${this.state.reference ?? 'unknown'})`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(_props: BoundaryProps, prev: BoundaryState): void {
    // Try again failed once more: its button is a new one, so give it the focus the old one had.
    if (this.state.failed && this.state.retried && this.state.reference !== prev.reference)
      this.retryButton.current?.focus();
  }

  private readonly retry = () => this.setState({ failed: false, retried: true });

  render() {
    const { label, layout, children } = this.props;
    const shown = label || UNNAMED_BLOCK;
    // Present from the first failure on, so the outcome of Try again is announced in the same live region.
    const live = (
      <span key="live" className="sr-only" aria-live="polite">
        {!this.state.failed && this.state.retried ? `${shown} is shown again` : ''}
      </span>
    );
    if (!this.state.failed)
      return this.state.retried ? [<Fragment key="block">{children}</Fragment>, live] : children;
    const retry =
      layout === 'cell' ? (
        // In a KPI cell Try again is an icon beside the reference, so the failed cell grows the strip as little as it can.
        <Tooltip content="Try again" side="bottom">
          <Button ref={this.retryButton} size="icon-sm" aria-label="Try again" onClick={this.retry}>
            <ArrowClockwiseIcon size={14} weight="bold" aria-hidden />
          </Button>
        </Tooltip>
      ) : (
        <Button ref={this.retryButton} size="sm" onClick={this.retry}>
          Try again
        </Button>
      );
    const view =
      layout === 'cell' ? (
        // Shaped like the strip's other cells: the label, then the reference and Try again, then "—" and the status at
        // the foot, in line with the other numbers. The chip shows the value only (its button names the reference), so
        // it stays on one line in a narrow cell.
        <Kpi
          variant="cell"
          label={shown}
          value="—"
          status={{ tone: 'crit', label: 'Couldn’t be shown' }}
          className="h-full"
          extra={
            // One row where the cell has room (Try again wraps under a whole chip where it hasn't).
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {this.state.reference && (
                <span
                  className="flex min-w-0"
                  title="Reference: send it with this page’s address to a portal administrator"
                >
                  <IdChip value={this.state.reference} label="Reference" showLabel={false} />
                </span>
              )}
              {retry}
            </div>
          }
        />
      ) : (
        <ErrorState
          compact
          title={cantBeShownTitle(label)}
          message="Something in its data couldn’t be displayed. The rest of the page still works, and nothing was changed."
          hint="If Try again doesn’t help, send a portal administrator the reference and this page’s address."
          correlationId={this.state.reference}
          action={retry}
        />
      );
    return [
      layout === 'panel' ? (
        <Panel key="block" title={label}>
          {view}
        </Panel>
      ) : (
        <Fragment key="block">{view}</Fragment>
      ),
      live,
    ];
  }
}

/**
 * Every widget renders inside a `WidgetBoundary` (the registry wraps them), so a crash in the widget itself — not
 * only in the parts `WidgetPanel` draws — costs that block only. KPI cells keep their place and shape in the strip.
 * `labelKey` is the config key that names the block on the page — `title` for most widgets, `label` for a KPI,
 * `heading` for a timeline (whose `title` is per event); an untitled block is "This part of the page".
 */
export function withWidgetBoundary<C>(
  Inner: ComponentType<WidgetProps<C>>,
  { labelKey = 'title' }: { labelKey?: string } = {},
): ComponentType<WidgetProps<C>> {
  function Guarded(props: WidgetProps<C>) {
    const given = (props.config as Record<string, unknown>)[labelKey];
    return (
      <WidgetBoundary
        label={typeof given === 'string' && given ? given : undefined}
        resetKey={props.data.value}
        layout={props.variant === 'cell' ? 'cell' : 'panel'}
      >
        <Inner {...props} />
      </WidgetBoundary>
    );
  }
  Guarded.displayName = `WidgetBoundary(${Inner.displayName ?? Inner.name})`;
  return Guarded;
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
  // Messages name the block as the page does; an untitled one is "This part of the page" (never a widget's noun).
  const label = title || UNNAMED_BLOCK;
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
      <WidgetBoundary label={title} resetKey={data.value} layout="body">
        {body}
      </WidgetBoundary>
    </Panel>
  );
}
