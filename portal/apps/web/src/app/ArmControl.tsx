import { useState, type FormEvent } from 'react';
import { Button, Dialog, EyeIcon, LightningIcon, LockKeyOpenIcon, Select, Textarea } from '@adminforge/ui';
import type { ArmRequest } from '@adminforge/schemas';
import {
  armDurations,
  DEFAULT_ARM_MAX_MINUTES,
  formatMinutes,
  formatRemaining,
  WARN_BEFORE_MS,
  type ArmState,
} from './arm';

export interface ArmControlProps {
  /** Portal.Operator: without it the Arm button is not rendered at all. */
  canArm: boolean;
  authMode: 'entra' | 'mock';
  arm: ArmState;
  /** Policy cap for the duration select (WRITE_SESSION_MAX_MINUTES). */
  maxMinutes?: number;
  tenantName?: string;
  dialogOpen: boolean;
  onDialogOpenChange: (open: boolean) => void;
  /** POST /auth/arm → redirect. Rejects with a user-facing message. */
  onArm: (request: ArmRequest) => Promise<void>;
  onExtend: () => Promise<void>;
  onDisarm: () => Promise<void>;
}

const REASON_MIN = 5;

function ArmDialog({
  open,
  onOpenChange,
  maxMinutes,
  authMode,
  tenantName,
  onArm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  maxMinutes: number;
  authMode: 'entra' | 'mock';
  tenantName?: string;
  onArm: (request: ArmRequest) => Promise<void>;
}) {
  const durations = armDurations(maxMinutes);
  const [minutes, setMinutes] = useState(() =>
    String(durations.includes(60) ? 60 : durations[durations.length - 1]),
  );
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reasonError =
    touched && reason.trim().length < REASON_MIN
      ? `Give a reason of at least ${REASON_MIN} characters. It goes in the audit log.`
      : undefined;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (reason.trim().length < REASON_MIN || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onArm({ minutes: Number(minutes), reason: reason.trim() });
    } catch (err) {
      setFailure((err as Error).message || 'Write access could not be started.');
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTouched(false);
          setFailure(null);
        }
        onOpenChange(next);
      }}
      title="Arm write access"
      description={`Write access lets you change ${tenantName ?? 'the tenant'} through AdminForge. It ends on its own, and every change is audited with your reason.`}
      footer={
        <>
          <Button intent="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button intent="armed" type="submit" form="arm-form" pending={pending}>
            <LightningIcon size={14} weight="fill" aria-hidden />
            {authMode === 'mock' ? 'Arm now' : 'Continue to sign-in'}
          </Button>
        </>
      }
    >
      <form id="arm-form" className="flex flex-col gap-4 pb-2" onSubmit={(e) => void submit(e)} noValidate>
        <Select
          label="Duration"
          value={minutes}
          onValueChange={setMinutes}
          options={durations.map((d) => ({ value: String(d), label: formatMinutes(d) }))}
          hint={`Your organisation allows up to ${formatMinutes(maxMinutes)}. You can extend once without signing in again.`}
        />
        <Textarea
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => setTouched(true)}
          maxLength={500}
          rows={3}
          placeholder="e.g. INC-4821: reset MFA for a locked-out user"
          error={reasonError}
          hint="Recorded in the audit log with every change you make."
        />
        <p className="flex items-start gap-2 rounded-md border border-line bg-sunken px-3 py-2.5 text-sm text-fg-2">
          <LockKeyOpenIcon size={16} className="mt-0.5 shrink-0 text-fg-3" aria-hidden />
          {authMode === 'mock'
            ? 'Mock sign-in is on: write access starts immediately, without step-up.'
            : 'You’ll sign in again with phishing-resistant MFA, then come straight back here.'}
        </p>
        {failure && (
          <p role="alert" className="rounded-md bg-crit-subtle px-3 py-2 text-sm text-crit">
            {failure}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * The mode indicator in the session rail. Read: a calm "Read-only" pill and Arm write access.
 * Armed: `Armed · 47:12`, Extend (once) and Disarm, while the rail glows ember (shell.css).
 */
export function ArmControl({
  canArm,
  authMode,
  arm,
  maxMinutes = DEFAULT_ARM_MAX_MINUTES,
  tenantName,
  dialogOpen,
  onDialogOpenChange,
  onArm,
  onExtend,
  onDisarm,
}: ArmControlProps) {
  const [busy, setBusy] = useState<'extend' | 'disarm' | null>(null);
  // One polite announcement when five minutes remain; the visible countdown itself is not live.
  const announcement =
    arm.armed && arm.remainingMs <= WARN_BEFORE_MS ? 'Write access ends in 5 minutes.' : '';

  const run = async (kind: 'extend' | 'disarm') => {
    setBusy(kind);
    try {
      await (kind === 'extend' ? onExtend() : onDisarm());
    } finally {
      setBusy(null);
    }
  };

  if (arm.armed) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-7 items-center gap-1.5 rounded-pill bg-on-armed px-3 font-mono text-xs font-bold whitespace-nowrap text-armed tabular-nums"
          aria-live="off"
        >
          <LightningIcon size={13} weight="fill" aria-hidden />
          {`Armed · ${formatRemaining(arm.remainingMs)}`}
        </span>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
        {arm.canExtend && (
          <Button
            size="sm"
            intent="ghost"
            pending={busy === 'extend'}
            onClick={() => void run('extend')}
            className="border-on-armed text-on-armed hover:not-aria-disabled:bg-on-armed/15 hover:not-aria-disabled:text-on-armed"
          >
            Extend
          </Button>
        )}
        <Button
          size="sm"
          pending={busy === 'disarm'}
          onClick={() => void run('disarm')}
          className="border-transparent bg-on-armed text-armed hover:not-aria-disabled:bg-on-armed hover:not-aria-disabled:opacity-90"
        >
          Disarm
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-pill border border-accent px-2.5 text-xs font-semibold whitespace-nowrap text-accent">
        <EyeIcon size={14} weight="bold" aria-hidden />
        Read-only
      </span>
      {canArm && (
        <>
          <Button size="sm" onClick={() => onDialogOpenChange(true)}>
            <LockKeyOpenIcon size={14} aria-hidden />
            Arm write access
          </Button>
          <ArmDialog
            open={dialogOpen}
            onOpenChange={onDialogOpenChange}
            maxMinutes={maxMinutes}
            authMode={authMode}
            tenantName={tenantName}
            onArm={onArm}
          />
        </>
      )}
    </div>
  );
}
