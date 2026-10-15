import { useState } from 'react';
import {
  Button,
  CheckIcon,
  cn,
  CopyIcon,
  EyeIcon,
  formatTimestamp,
  IconButton,
  Tooltip,
  useCopy,
  WarningIcon,
} from '@adminforge/ui';
import { humanize } from '../playbooks/form';
import { Callout } from '../ops/ui';
import type { SecretNoticeState } from './useRunLive';
import { isSecretMask, maskText, secretKey, SHOWN_ONCE_TOOLTIP, type SecretMessage } from './secrets';

const MASK = '••••••••••••';

function SecretField({ name, value, hint }: { name: string; value: string; hint?: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, copy] = useCopy();
  const label = humanize(name);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-2">{label}</span>
      <div className="flex min-w-0 items-center gap-1 rounded-(--af-input-radius) border border-line-strong bg-sunken py-1 pr-1 pl-3">
        <code className={cn('min-w-0 flex-1 truncate font-mono text-md text-fg', !revealed && 'tracking-widest text-fg-2')}>
          <span aria-hidden={!revealed || undefined}>{revealed ? value : MASK}</span>
          {!revealed && <span className="sr-only">hidden</span>}
        </code>
        <IconButton
          size="sm"
          label={revealed ? `Hide ${label}` : `Show ${label}`}
          aria-pressed={revealed}
          icon={<EyeIcon size={15} weight={revealed ? 'fill' : 'regular'} />}
          onClick={() => setRevealed((r) => !r)}
        />
        <IconButton
          size="sm"
          label={copied ? `${label} copied` : `Copy ${label}`}
          icon={copied ? <CheckIcon size={15} weight="bold" className="text-ok" /> : <CopyIcon size={15} />}
          onClick={() => void copy(value)}
        />
        <span className="sr-only" aria-live="polite">
          {copied ? `${label} copied` : ''}
        </span>
      </div>
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
    </div>
  );
}

/**
 * "Copy now — it won't be shown again": the one moment a Temporary Access Pass, temporary password or new app
 * secret is visible. Masked until revealed, per-field copy, and Dismiss forgets it (it was only ever in memory).
 */
export function SecretPanel({
  secret,
  stepLabel,
  childRun,
  onDismiss,
}: {
  secret: SecretMessage;
  stepLabel: string;
  /** Set when the secret came from a child run of the run being viewed. */
  childRun?: boolean;
  onDismiss: () => void;
}) {
  const titleId = `secret-${secretKey(secret).replace(/[^\w-]/g, '_')}`;
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-(--af-panel-radius) border-2 border-warn bg-panel p-(--af-pad-panel) shadow-2"
    >
      <span className="sr-only" role="status">
        A one-time secret is ready to copy.
      </span>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="af-eyebrow flex items-center gap-1.5 text-warn">
            <WarningIcon size={13} weight="fill" aria-hidden />
            Shown once
          </p>
          <h2 id={titleId} className="af-display text-lg font-semibold text-fg">
            Copy now — it won’t be shown again
          </h2>
          <p className="text-sm text-fg-2">
            From “{stepLabel}”{childRun ? ' (child run)' : ''}
            {secret.producedAt ? ` · ${formatTimestamp(secret.producedAt)}` : ''}. Give it to the person over a verified channel.
          </p>
        </div>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(secret.values).map(([field, value]) => (
          <SecretField key={field} name={field} value={value} hint={secret.hints[field]} />
        ))}
      </div>
      {secret.note && <p className="text-sm text-fg-2">{secret.note}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <p className="text-xs text-fg-3">AdminForge doesn’t keep it: leaving this page or dismissing forgets it.</p>
        <Button onClick={onDismiss}>I’ve copied it — dismiss</Button>
      </div>
    </section>
  );
}

const NOTICE_TEXT: Record<SecretNoticeState['status'], string> = {
  delivered: 'It was shown once to the person who ran this and isn’t available any more.',
  sent: 'It was sent as the playbook specifies and isn’t shown here.',
  discarded: 'It was discarded without being shown. Run the step again if it’s still needed.',
  held: 'It’s waiting for the person who ran this.',
};

/** A secret this page can't show (already shown, sent, discarded, or claimed elsewhere). */
export function SecretNotices({ notices, labelFor }: { notices: SecretNoticeState[]; labelFor: (stepId: string) => string }) {
  const shown = notices.filter((n) => n.status !== 'held' || n.error);
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((n) => (
        <Callout key={`${n.runId}:${n.stepPath}`} tone="neutral" title={`“${labelFor(n.stepId)}” produced a one-time secret`}>
          {n.error ?? NOTICE_TEXT[n.status]}
          {n.fields.length > 0 && <span className="mt-1 block text-xs text-fg-3">Fields: {n.fields.map(humanize).join(', ')}</span>}
        </Callout>
      ))}
    </div>
  );
}

/** `{ "$secret": true, "hint": "…" }` in stored outputs: "•••• hint", explained on hover/focus. */
export function MaskedSecret({ value }: { value: unknown }) {
  if (!isSecretMask(value)) return null;
  return (
    <Tooltip content={SHOWN_ONCE_TOOLTIP}>
      <span tabIndex={0} className="rounded-sm font-mono text-xs text-fg-2 outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {maskText(value)}
        <span className="sr-only"> ({SHOWN_ONCE_TOOLTIP})</span>
      </span>
    </Tooltip>
  );
}
