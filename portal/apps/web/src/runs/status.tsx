import { CircleNotchIcon, cn, HourglassMediumIcon, STATUS_ICON, statusPill, type StatusTone } from '@adminforge/ui';
import type { RunStatus, StepStatus } from './contracts';

/** Run states in words engineers use, with the tone that carries them (never colour alone: glyph + label). */
export const RUN_STATUS_VIEW: Record<RunStatus, { tone: StatusTone; label: string }> = {
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'info', label: 'Running' },
  awaiting_approval: { tone: 'warn', label: 'Awaiting approval' },
  awaiting_input: { tone: 'warn', label: 'Needs input' },
  awaiting_arm: { tone: 'warn', label: 'Needs write access' },
  awaiting_reauth: { tone: 'warn', label: 'Needs sign-in' },
  succeeded: { tone: 'ok', label: 'Succeeded' },
  failed: { tone: 'crit', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  compensated: { tone: 'warn', label: 'Rolled back' },
  needs_review: { tone: 'crit', label: 'Needs review' },
};

export const STEP_STATUS_VIEW: Record<StepStatus, { tone: StatusTone; label: string }> = {
  pending: { tone: 'neutral', label: 'Not started' },
  running: { tone: 'info', label: 'Running' },
  waiting: { tone: 'warn', label: 'Waiting' },
  succeeded: { tone: 'ok', label: 'Done' },
  failed: { tone: 'crit', label: 'Failed' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  planned: { tone: 'info', label: 'Planned' },
  retried: { tone: 'neutral', label: 'Retried' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  compensated: { tone: 'warn', label: 'Rolled back' },
  needs_review: { tone: 'crit', label: 'Needs review' },
};

const TONE_TEXT: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  info: 'text-info',
  neutral: 'text-fg-3',
};

const isWaiting = (status: string) => status === 'waiting' || status === 'queued' || status.startsWith('awaiting_');

/**
 * State glyph: running spins (still under reduced motion: it just stops), waiting is an hourglass, everything else
 * uses the tone's own shape. `colored` paints it in the tone.
 */
export function StatusGlyph({
  status,
  tone,
  size = 14,
  colored,
  className,
}: {
  status: string;
  tone: StatusTone;
  size?: number;
  colored?: boolean;
  className?: string;
}) {
  const cls = cn('shrink-0', colored && TONE_TEXT[tone], className);
  if (status === 'running')
    return <CircleNotchIcon size={size} weight="bold" aria-hidden className={cn(cls, 'animate-spin motion-reduce:animate-none')} />;
  if (isWaiting(status)) return <HourglassMediumIcon size={size} weight="fill" aria-hidden className={cls} />;
  const Glyph = STATUS_ICON[tone];
  return <Glyph size={size} weight="fill" aria-hidden className={cls} />;
}

export function RunStatusPill({
  status,
  size = 'md',
  className,
}: {
  status: RunStatus;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const view = RUN_STATUS_VIEW[status];
  const s = statusPill({ status: view.tone, size });
  return (
    <span className={s.root({ className })} data-status={status}>
      <StatusGlyph status={status} tone={view.tone} size={size === 'sm' ? 12 : 14} className={s.icon()} />
      <span className={s.label()}>{view.label}</span>
    </span>
  );
}
