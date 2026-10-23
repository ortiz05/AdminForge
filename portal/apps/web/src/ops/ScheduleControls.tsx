import { useState } from 'react';
import { errorDescription } from '../lib/errors';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Button,
  ConfirmDialog,
  PlayIcon,
  Select,
  StatusPill,
  Switch,
  TrashIcon,
  useToast,
} from '@adminforge/ui';
import { formatInZone, nextRuns } from './cron';
import {
  deleteSchedule,
  runScheduleNow,
  runsAsPhrase,
  scheduleIdentitiesQuery,
  setScheduleEnabled,
  setScheduleRunAs,
  type ScheduleItem,
} from './schedules';

/**
 * Enable / disable a schedule. Read-only jobs switch at once. Write-capable ones (playbook or script jobs that change
 * the tenant) run unattended as the automation identity, so enabling them asks a second person (Playbook Approver)
 * first: the API answers 202 { approvalId } and the switch shows "Awaiting approval" until someone decides.
 */
export function ScheduleToggle({ schedule, withLabel }: { schedule: ScheduleItem; withLabel?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => setScheduleEnabled(schedule.key, enabled),
    onSuccess: ({ approvalId }, enabled) => {
      if (approvalId) {
        toast({
          tone: 'info',
          title: 'Approval requested',
          description: `${schedule.title} turns on once a Playbook Approver approves it.`,
        });
      } else if (enabled) {
        const next = nextRuns(schedule.cron, schedule.timezone, 1)[0];
        toast({
          tone: 'ok',
          title: `${schedule.title} enabled`,
          description: next
            ? `Next run ${formatInZone(next, schedule.timezone)} (${schedule.timezone.replace(/_/g, ' ')}).`
            : undefined,
        });
      } else {
        toast({
          tone: 'info',
          title: `${schedule.title} paused`,
          description: 'It won’t run again until you enable it.',
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (e) =>
      toast({ tone: 'crit', title: 'The schedule didn’t change', description: errorDescription(e) }),
  });

  if (schedule.pendingApprovalId && !schedule.enabled)
    return (
      <Link
        to="/approvals"
        className="rounded-pill"
        aria-label={`${schedule.title}: enabling is awaiting approval. Open approvals.`}
      >
        <StatusPill status="warn" size="sm">
          Awaiting approval
        </StatusPill>
      </Link>
    );

  const label = `${schedule.enabled ? 'Disable' : 'Enable'} ${schedule.title}`;
  return (
    <>
      <Switch
        aria-label={withLabel ? undefined : label}
        label={withLabel ? (schedule.enabled ? 'Enabled' : 'Disabled') : undefined}
        description={
          withLabel && !schedule.enabled
            ? schedule.writeCapable
              ? 'Enabling needs a second approver.'
              : schedule.job.kind === 'report'
                ? 'Run now only writes the file until you enable it.'
                : 'Run now sends nothing until you enable it.'
            : undefined
        }
        checked={schedule.enabled}
        disabled={mutation.isPending}
        onCheckedChange={(on) => {
          if (on && schedule.writeCapable) setConfirming(true);
          else mutation.mutate(on);
        }}
      />
      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirming(false)}
          title={`Ask for approval to enable ${schedule.title}?`}
          description={`This schedule can change your tenant. It runs unattended ${runsAsPhrase(schedule.runsAs)}, so a second person with the Playbook Approver role must approve before it turns on.`}
          confirmLabel="Request approval"
          intent="primary"
          onConfirm={() => mutation.mutateAsync(true).then(() => undefined)}
        />
      )}
    </>
  );
}

/**
 * What Run now does on a disabled schedule (F-10): the job runs, but nothing is sent until the schedule is enabled — a
 * report only writes its file. Null while it is enabled, and for write-capable jobs (Run now refuses those until a
 * second person approved enabling them).
 */
export function fileOnlyNote(
  schedule: Pick<ScheduleItem, 'enabled' | 'writeCapable' | 'job'>,
): string | null {
  if (schedule.enabled || schedule.writeCapable) return null;
  return schedule.job.kind === 'report'
    ? 'This schedule is disabled, so Run now only writes the file: it sends no email, Teams message or notification.'
    : 'This schedule is disabled, so Run now sends no email, Teams message or notification.';
}

/** The toast after Run now: what it does, from the API's answer (the page's state may be a moment old). */
function startedText(schedule: ScheduleItem, fileOnly: boolean): string {
  if (!fileOnly) return `It runs ${runsAsPhrase(schedule.runsAs)}; the result appears in its history.`;
  return schedule.job.kind === 'report'
    ? 'The schedule is disabled, so this run only writes the file and sends nothing. To send it, enable the schedule and run it again.'
    : 'The schedule is disabled, so this run sends no email, Teams message or notification. The result appears in its history.';
}

/**
 * Run the job now, as whoever the schedule runs as. Write-capable jobs confirm first; one that waits for its creator to
 * sign in is locked, saying so. On a disabled schedule it sends nothing, and says so before (its description) and
 * after (the toast).
 */
export function RunNowButton({ schedule, size = 'sm' }: { schedule: ScheduleItem; size?: 'sm' | 'md' }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const fileOnly = fileOnlyNote(schedule);
  const mutation = useMutation({
    mutationFn: () => runScheduleNow(schedule.key),
    onSuccess: (r) => {
      toast({
        tone: 'info',
        title: `${schedule.title} started`,
        description: startedText(schedule, r.fileOnly),
      });
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      void queryClient.invalidateQueries({ queryKey: ['schedule-runs', schedule.key] });
    },
    onError: (e) =>
      toast({ tone: 'crit', title: `${schedule.title} didn’t start`, description: errorDescription(e) }),
  });
  const r = schedule.runsAs;
  const locked =
    r.kind === 'user' && r.signIn !== 'signed_in'
      ? r.canSignIn
        ? 'Sign in for this schedule first.'
        : `Waits for ${r.name ?? 'its creator'} to sign in.`
      : undefined;
  return (
    <>
      <Button
        size={size}
        pending={mutation.isPending}
        locked={locked}
        title={locked ?? fileOnly ?? undefined}
        aria-label={size === 'sm' ? `Run ${schedule.title} now` : undefined}
        onClick={() => (schedule.writeCapable ? setConfirming(true) : mutation.mutate())}
      >
        {/* Locked: the button shows its lock instead (same width as the others in the list). */}
        {!locked && <PlayIcon size={12} weight="fill" aria-hidden />}
        Run now
      </Button>
      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirming(false)}
          title={`Run ${schedule.title} now?`}
          description={`This job can change your tenant. It runs immediately ${runsAsPhrase(schedule.runsAs)}, outside its schedule, and is audited as started by you.`}
          confirmLabel="Run now"
          intent="primary"
          onConfirm={() => mutation.mutateAsync().then(() => undefined)}
        />
      )}
    </>
  );
}

/**
 * Delete a portal schedule (shown only when `canManage`). It stops running and leaves the lists; its run history and
 * files stay until retention removes them. Confirms first.
 */
export function DeleteScheduleButton({
  schedule,
  size = 'sm',
  onDeleted,
}: {
  schedule: Pick<ScheduleItem, 'key' | 'title'>;
  size?: 'sm' | 'md';
  onDeleted?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteSchedule(schedule.key),
    onSuccess: () => {
      toast({ tone: 'ok', title: 'Schedule deleted', description: `${schedule.title} won’t run again.` });
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      onDeleted?.();
    },
    onError: (e) =>
      toast({ tone: 'crit', title: 'The schedule wasn’t deleted', description: errorDescription(e) }),
  });
  return (
    <ConfirmDialog
      trigger={
        <Button
          size={size}
          intent="ghost"
          aria-label={size === 'sm' ? `Delete ${schedule.title}` : undefined}
        >
          <TrashIcon size={size === 'sm' ? 12 : 14} aria-hidden />
          Delete
        </Button>
      }
      title={`Delete ${schedule.title}?`}
      description="It stops running and leaves the schedule lists. Its run history and files stay until they age out."
      confirmLabel="Delete schedule"
      intent="danger"
      // A failure is reported in a toast; the dialog closes either way.
      onConfirm={() =>
        mutation.mutateAsync().then(
          () => undefined,
          () => undefined,
        )
      }
    />
  );
}

/** The select's value for "no choice here": the schedule's definition or the installation default decides. */
const DEFAULT_RUN_AS = 'default';

/** Where the account comes from, in a sentence (null when there's nothing to add). */
export function runAsOrigin(s: ScheduleItem): string | null {
  const r = s.runsAs;
  if (r.source === 'override')
    return `Chosen here${r.setBy ? ` by ${r.setBy}` : ''}${r.setAt ? ` on ${r.setAt.slice(0, 10)}` : ''}.`;
  if (r.source === 'default') return 'The installation’s default for this kind of schedule.';
  if (r.source === 'definition') return 'Named by the schedule’s definition in content.';
  return null;
}

/**
 * Choose the account a content schedule runs as (Portal.Operator): the automation identity or an app identity, over
 * what its definition names, or back to the default. The identity must already hold the permissions the schedule
 * declares (the API says which are missing); a write-capable schedule is turned off and needs approval again.
 */
export function RunAsControl({ schedule }: { schedule: ScheduleItem }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const identities = useQuery(scheduleIdentitiesQuery);
  const r = schedule.runsAs;
  const current =
    r.source === 'override' ? (r.kind === 'app' && r.name ? `app:${r.name}` : 'automation') : DEFAULT_RUN_AS;
  const [value, setValue] = useState(current);
  const mutation = useMutation({
    mutationFn: (v: string) => setScheduleRunAs(schedule.key, v === DEFAULT_RUN_AS ? null : v),
    onSuccess: ({ disabled }) => {
      toast({
        tone: disabled ? 'info' : 'ok',
        title: 'Account changed',
        description: disabled
          ? `${schedule.title} is off: turning it on again asks a second person to approve the new account.`
          : `${schedule.title} uses it from its next run.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (e) => {
      setValue(current);
      toast({ tone: 'crit', title: 'The account didn’t change', description: errorDescription(e) });
    },
  });
  const apps = identities.data?.apps ?? [];
  // Without app identities the only account is the automation identity: nothing to choose.
  if (!apps.length) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <Select
        label="Run as"
        value={value}
        onValueChange={setValue}
        options={[
          { value: DEFAULT_RUN_AS, label: 'Default' },
          { value: 'automation', label: 'Automation identity' },
          ...apps.map((name) => ({ value: `app:${name}`, label: `App identity ${name}` })),
        ]}
        hint={
          schedule.writeCapable
            ? 'Changing it turns the schedule off; turning it on again needs a second person’s approval for the new account.'
            : 'The identity needs the permissions this schedule declares; AdminForge checks before it saves.'
        }
      />
      <div>
        <Button
          size="sm"
          disabled={value === current || mutation.isPending}
          onClick={() => mutation.mutate(value)}
        >
          {mutation.isPending ? 'Saving…' : 'Save account'}
        </Button>
      </div>
    </div>
  );
}
