import type { ReactNode } from 'react';
import { TrayIcon, WarningOctagonIcon } from '@phosphor-icons/react';

import { Badge } from './Badge';
import { IdChip } from './IdChip';
import { feedbackState } from '../recipes/states';

export interface EmptyStateProps {
  title: string;
  /** One line of guidance: what to do next. */
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Nothing to show yet — an invitation to act, not a mood. */
export function EmptyState({ title, children, icon, action, compact, className }: EmptyStateProps) {
  const s = feedbackState({ tone: 'empty', compact });
  return (
    <div className={s.root({ className })}>
      <span className={s.glyph()} aria-hidden>
        {icon ?? <TrayIcon size={20} />}
      </span>
      <p className={s.title()}>{title}</p>
      {children && <div className={s.body()}>{children}</div>}
      {action && <div className={s.actions()}>{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  /** What happened, in plain words. */
  message?: ReactNode;
  /** What to do about it. */
  hint?: ReactNode;
  /** Machine code from the API ("forbidden", "graph_throttled"). */
  code?: string;
  /** Correlation id for logs and support tickets. */
  correlationId?: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Says what went wrong and what to do; carries the code and correlation id engineers need to trace it. */
export function ErrorState({
  title,
  message,
  hint,
  code,
  correlationId,
  action,
  compact,
  className,
}: ErrorStateProps) {
  const s = feedbackState({ tone: 'error', compact });
  return (
    <div className={s.root({ className })} role="alert">
      <span className={s.glyph()} aria-hidden>
        <WarningOctagonIcon size={20} weight="fill" />
      </span>
      <p className={s.title()}>{title}</p>
      {message && <div className={s.body()}>{message}</div>}
      {hint && <div className={s.body()}>{hint}</div>}
      {(code || correlationId) && (
        <div className={s.meta()}>
          {code && (
            <Badge tone="outline" mono>
              {code}
            </Badge>
          )}
          {correlationId && <IdChip value={correlationId} label="Correlation ID" />}
        </div>
      )}
      {action && <div className={s.actions()}>{action}</div>}
    </div>
  );
}
