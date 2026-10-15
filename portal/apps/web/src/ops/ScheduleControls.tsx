import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button, ConfirmDialog, PlayIcon, StatusPill, Switch, useToast } from '@adminforge/ui';
import { formatInZone, nextRuns } from './cron';
import { runScheduleNow, setScheduleEnabled, type ScheduleItem } from './schedules';

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
            ? `Next run ${formatInZone(next, schedule.timezone)} (${schedule.timezone}).`
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
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (e) =>
      toast({ tone: 'crit', title: 'The schedule didn’t change', description: (e as Error).message }),
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
          withLabel && schedule.writeCapable && !schedule.enabled
            ? 'Enabling needs a second approver.'
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
          description="This schedule can change your tenant. It runs unattended as the automation identity, so a second person with the Playbook Approver role must approve before it turns on."
          confirmLabel="Request approval"
          intent="primary"
          onConfirm={() => mutation.mutateAsync(true).then(() => undefined)}
        />
      )}
    </>
  );
}

/** Run the job now (as the automation identity). Write-capable jobs confirm first. */
export function RunNowButton({ schedule, size = 'sm' }: { schedule: ScheduleItem; size?: 'sm' | 'md' }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: () => runScheduleNow(schedule.key),
    onSuccess: () => {
      toast({
        tone: 'info',
        title: `${schedule.title} started`,
        description: 'It runs as the automation identity; the result appears in its history.',
      });
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['schedule-runs', schedule.key] });
    },
    onError: (e) =>
      toast({ tone: 'crit', title: `${schedule.title} didn’t start`, description: (e as Error).message }),
  });
  return (
    <>
      <Button
        size={size}
        pending={mutation.isPending}
        aria-label={size === 'sm' ? `Run ${schedule.title} now` : undefined}
        onClick={() => (schedule.writeCapable ? setConfirming(true) : mutation.mutate())}
      >
        <PlayIcon size={12} weight="fill" aria-hidden />
        Run now
      </Button>
      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirming(false)}
          title={`Run ${schedule.title} now?`}
          description="This job can change your tenant. It runs immediately as the automation identity, outside its schedule, and is audited as started by you."
          confirmLabel="Run now"
          intent="primary"
          onConfirm={() => mutation.mutateAsync().then(() => undefined)}
        />
      )}
    </>
  );
}
