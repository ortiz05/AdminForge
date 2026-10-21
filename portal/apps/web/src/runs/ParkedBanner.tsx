import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  formatRelative,
  formatTimestamp,
  HourglassMediumIcon,
  LockKeyOpenIcon,
  useToast,
} from '@adminforge/ui';
import { useShell } from '../app/shell-context';
import { api, loginUrl } from '../lib/api';
import { browser } from '../lib/browser';
import { errorDescription } from '../lib/errors';
import { useMe } from '../lib/session';
import { Callout } from '../ops/ui';
import { labelOf, latestSteps, type RunDetail, type StepIndex } from './contracts';
import { runDetailQuery } from './queries';

/** POST /api/runs/:id/resume — the way out of `awaiting_arm` and `awaiting_reauth` — then the run reloads. */
function useResumeRun(id: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    onSuccess: () => {
      toast({ tone: 'info', title: 'Run resumed' });
      void queryClient.invalidateQueries({ queryKey: runDetailQuery(id).queryKey });
    },
    onError: (e) => toast({ tone: 'crit', title: 'The run didn’t resume', description: errorDescription(e) }),
  });
}

/**
 * What a parked run is waiting for, and the one thing that moves it on (arm, sign in, resume). The run page and the
 * runbook page show the same banner, so a run reads the same wherever it is open.
 */
export function ParkedBanner({ detail, index }: { detail: RunDetail; index: StepIndex }) {
  const me = useMe();
  const { arm, openArmDialog } = useShell();
  const run = detail.run;
  const resume = useResumeRun(run.id);
  const onResume = () => resume.mutate();
  const resuming = resume.isPending;
  const steps = latestSteps(detail.steps);
  const waitingStep = run.waiting?.stepId ?? steps.find((s) => s.status === 'waiting')?.stepId;
  const status =
    run.waiting?.kind === 'arm'
      ? 'awaiting_arm'
      : run.waiting?.kind === 'reauth'
        ? 'awaiting_reauth'
        : run.status;

  // S-08: started before its session last turned write access on — it changes nothing until its person resumes it.
  const prearm = status === 'awaiting_arm' && run.waiting?.reason === 'prearm';
  const started = run.waiting?.startedAt ?? run.startedAt ?? run.createdAt;

  // Write access and a fresh sign-in are the initiator's to give: anyone else is told who the run waits for.
  const mine = run.initiator.oid !== null && run.initiator.oid === me.user.oid;
  if (!mine && (status === 'awaiting_arm' || status === 'awaiting_reauth')) {
    const who = run.initiator.upn ?? 'the person who started it';
    return (
      <Callout
        tone="neutral"
        icon={<HourglassMediumIcon size={18} />}
        title={
          prearm
            ? `Paused until ${who} resumes it`
            : status === 'awaiting_arm'
              ? `Paused until ${who} arms write access`
              : `Paused until ${who} signs in again`
        }
      >
        {prearm
          ? 'It started before they last armed write access, so nothing changes until they check it’s theirs and resume it.'
          : 'The next step runs with their access, so nothing else runs until they do.'}
      </Callout>
    );
  }
  if (prearm)
    return (
      <Callout
        tone="warn"
        icon={<LockKeyOpenIcon size={18} />}
        title="Paused: check this run is yours, then resume it"
        action={
          arm.armed ? (
            <Button intent="primary" pending={resuming} onClick={onResume}>
              Resume run
            </Button>
          ) : me.canArm ? (
            <Button onClick={openArmDialog}>
              <LockKeyOpenIcon size={14} aria-hidden />
              Arm write access
            </Button>
          ) : undefined
        }
      >
        {!arm.armed && (me.canArm ? 'Arm write access, then resume it. ' : '')}
        It started{' '}
        {started ? (
          <time dateTime={started} title={formatTimestamp(started)}>
            {formatRelative(started)}
          </time>
        ) : (
          'earlier'
        )}
        , before you last armed write access, so nothing changes until you resume it. Check the {run.kind},
        its inputs and the start time are yours. If you don’t recognise it, cancel it and tell your security
        team.
        {!arm.armed &&
          !me.canArm &&
          ' Resuming it needs the Portal Operator role: ask a portal administrator for it.'}
      </Callout>
    );
  switch (status) {
    case 'awaiting_arm':
      return (
        <Callout
          tone="warn"
          icon={<LockKeyOpenIcon size={18} />}
          title="Paused: the next step changes your tenant and needs write access"
          action={
            arm.armed ? (
              <Button intent="primary" pending={resuming} onClick={onResume}>
                Resume run
              </Button>
            ) : me.canArm ? (
              <Button onClick={openArmDialog}>
                <LockKeyOpenIcon size={14} aria-hidden />
                Arm write access
              </Button>
            ) : undefined
          }
        >
          {arm.armed
            ? 'Write access is on. Resume to continue from where the run stopped.'
            : `Write access ended before ${waitingStep ? `“${labelOf(index, waitingStep)}”` : 'the next step'} could start. Arm again, then resume — nothing that already ran is repeated.`}
        </Callout>
      );
    case 'awaiting_reauth':
      return (
        <Callout
          tone="warn"
          title="Paused: Microsoft asked you to sign in again"
          action={
            <>
              <Button onClick={() => browser.assign(loginUrl('/auth/login'))}>Sign in again</Button>
              <Button intent="ghost" pending={resuming} onClick={onResume}>
                Resume run
              </Button>
            </>
          }
        >
          Your session needs fresh credentials (sign-in frequency, Conditional Access, or revoked tokens).
          Sign in, then resume.
        </Callout>
      );
    case 'needs_review': {
      const stuck = steps.find((s) => s.status === 'needs_review');
      return (
        <Callout tone="crit" title="Needs review: a step may or may not have happened">
          {stuck ? `“${labelOf(index, stuck.stepId)}”` : 'A step'} can’t be retried safely and was in flight
          when the worker stopped. Check the target in the Microsoft admin center before running anything
          again.
        </Callout>
      );
    }
    default:
      return null;
  }
}
