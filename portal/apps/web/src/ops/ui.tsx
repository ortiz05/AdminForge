import { useEffect, type ReactNode } from 'react';
import { Button, cn, ErrorState, STATUS_ICON, type StatusTone } from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';

/** Shared bits for the automation and admin pages (runs, approvals, schedules, monitoring, audit, appearance). */

const CALLOUT_TONE: Record<StatusTone, string> = {
  ok: 'border-ok/40 bg-ok-subtle',
  warn: 'border-warn/40 bg-warn-subtle',
  crit: 'border-crit/40 bg-crit-subtle',
  info: 'border-accent/30 bg-accent-subtle',
  neutral: 'border-line bg-raised',
};
const GLYPH_TONE: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  info: 'text-info',
  neutral: 'text-fg-3',
};

/** A tinted note: what is going on, in one line, plus detail and an optional action. Glyph + words, not colour alone. */
export function Callout({
  tone = 'info',
  title,
  children,
  action,
  icon,
  role,
  className,
}: {
  tone?: StatusTone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  const Glyph = STATUS_ICON[tone];
  return (
    <div
      role={role}
      className={cn('flex gap-3 rounded-(--af-panel-radius) border px-4 py-3', CALLOUT_TONE[tone], className)}
    >
      <span className={cn('mt-0.5 flex shrink-0', GLYPH_TONE[tone])} aria-hidden>
        {icon ?? <Glyph size={18} weight="fill" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold text-fg">{title}</p>
        {children && <div className="text-sm text-fg-2">{children}</div>}
        {action && <div className="mt-1.5 flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

/** Label/value pairs in a two-column grid (run details, schedule facts, settings). */
export function Facts({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn('flex flex-col gap-2.5 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="flex min-w-0 items-baseline gap-4">
          <dt className="w-32 shrink-0 text-fg-3">{k}</dt>
          <dd className="min-w-0 flex-1 break-words text-fg">{v ?? <span className="text-fg-3">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** ErrorState for a failed query: message, hint, code and correlation id from the BFF's error body. */
export function QueryError({
  title,
  error,
  onRetry,
  compact,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const e = error instanceof ApiRequestError ? error : null;
  return (
    <ErrorState
      compact={compact}
      title={title}
      message={(error as Error)?.message}
      hint={e?.hint}
      code={e?.code}
      correlationId={e?.correlationId}
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  );
}

/** A 403 from a Portal.Admin-only endpoint reads as "you need the role", not as a failure. */
export const isForbidden = (error: unknown) => error instanceof ApiRequestError && error.status === 403;

/** Sets the tab title while the page is shown. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `${title} · AdminForge`;
    return () => {
      document.title = before;
    };
  }, [title]);
}

/** "12 s", "4 min 10 s", "2 h 5 min" between two ISO times (or until now). */
export function elapsed(
  from: string | null | undefined,
  to: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!from) return null;
  const ms = (to ? Date.parse(to) : now) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
