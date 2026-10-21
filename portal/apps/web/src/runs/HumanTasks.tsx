import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Badge,
  Button,
  Checkbox,
  formatRelative,
  formatTimestamp,
  LockKeyOpenIcon,
  SealCheckIcon,
  StatusPill,
  Textarea,
  useNow,
  useToast,
} from '@adminforge/ui';
import { WriteAction } from '../app/WriteAction';
import { useShell } from '../app/shell-context';
import { activeRunsQueryKey } from './keys';
import { api, ApiRequestError } from '../lib/api';
import { useMe } from '../lib/session';
import { Callout } from '../ops/ui';
import { decide, type ApprovalItem, type Decision } from './approvals';
import { Markdown } from './Markdown';

const DECIDED = {
  approved: { tone: 'ok', label: 'Approved' },
  rejected: { tone: 'crit', label: 'Rejected' },
  expired: { tone: 'neutral', label: 'Expired' },
} as const;

const SUBJECT_LABEL: Record<ApprovalItem['subjectType'], string> = {
  run: 'Run',
  schedule: 'Schedule',
  definition: 'Content publish',
};

/**
 * One approval request (§5.3 Playbook.Approver, ADR-010): who asked, what for, when it expires; approve or reject
 * with a comment. Approving a run's remaining write steps makes the approver the identity those steps run as, so
 * it needs write access — the button stays locked in read mode with the reason, and Arm is one click away.
 */
export function ApprovalCard({
  item,
  compact,
  headingLevel = 3,
}: {
  item: ApprovalItem;
  compact?: boolean;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const me = useMe();
  const { arm, openArmDialog } = useShell();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const now = useNow(30_000);
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const own = item.requestedBy.toLowerCase() === me.user.upn.toLowerCase();
  const canDecide =
    item.canDecide ?? (me.roles.includes('Playbook.Approver') || me.roles.includes('Portal.Admin'));
  const expired = item.expiresAt ? Date.parse(item.expiresAt) <= now : false;

  const mutation = useMutation({
    mutationFn: (decision: Decision) => decide(item, decision, comment),
    onSuccess: (_d, decision) => {
      toast({
        tone: decision === 'approve' ? 'ok' : 'info',
        title: decision === 'approve' ? `Approved: ${item.title}` : `Rejected: ${item.title}`,
        description:
          item.subjectType === 'run'
            ? decision === 'approve'
              ? 'The run continues, with the remaining steps running as you.'
              : 'The run stops at this step.'
            : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: activeRunsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });

  const Approve = item.requiresArm ? WriteAction : Button;
  return (
    <article
      aria-label={`Approval: ${item.title}`}
      className="flex flex-col gap-3 rounded-(--af-panel-radius) border border-line bg-panel p-(--af-pad-panel)"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="af-eyebrow flex items-center gap-1.5">
            <SealCheckIcon size={12} weight="fill" aria-hidden />
            {SUBJECT_LABEL[item.subjectType]} approval
          </p>
          <Heading className="text-md font-semibold text-fg">
            {item.subjectType === 'run' ? (
              <Link to="/runs/$id" params={{ id: item.subjectId }} className="hover:underline">
                {item.title}
              </Link>
            ) : item.subjectType === 'schedule' && item.ref ? (
              <Link to="/schedules/$key" params={{ key: item.ref }} className="hover:underline">
                {item.title}
              </Link>
            ) : (
              item.title
            )}
          </Heading>
          <p className="text-xs text-fg-3">
            Requested by <span className="text-fg-2">{item.requestedBy}</span>
            {item.createdAt && (
              <>
                {' · '}
                <time dateTime={item.createdAt} title={formatTimestamp(item.createdAt)}>
                  {formatRelative(item.createdAt, now)}
                </time>
              </>
            )}
            {item.expiresAt && (
              <>
                {' · '}
                <time
                  dateTime={item.expiresAt}
                  title={formatTimestamp(item.expiresAt)}
                  className={expired ? 'text-crit' : undefined}
                >
                  {expired ? 'expired' : `expires ${formatRelative(item.expiresAt, now)}`}
                </time>
              </>
            )}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-1.5">
          {item.subjectType === 'run' && !compact && (
            <Link
              to="/runs/$id"
              params={{ id: item.subjectId }}
              className="mr-1 text-xs font-semibold text-accent hover:underline"
            >
              Open run
            </Link>
          )}
          {item.approvers.map((a) => (
            <Badge key={a}>{a}</Badge>
          ))}
          {item.minApprovals > 1 && <Badge tone="outline">{item.minApprovals} approvals needed</Badge>}
        </span>
      </header>
      {item.message && <Markdown source={item.message} />}
      {item.status !== 'pending' ? (
        <p>
          <StatusPill status={DECIDED[item.status].tone} size="sm">
            {DECIDED[item.status].label}
          </StatusPill>
        </p>
      ) : own ? (
        <Callout tone="neutral" title="You asked for this approval">
          Someone else with the Playbook Approver role has to decide. You can still cancel the run.
        </Callout>
      ) : !canDecide ? (
        <Callout tone="neutral" title="You can’t decide this one">
          Approving needs the Playbook Approver role. Ask a Portal Admin if you should have it.
        </Callout>
      ) : expired ? (
        <Callout tone="warn" title="This request expired">
          The {item.subjectType} didn’t get a decision in time. Start it again if it’s still needed.
        </Callout>
      ) : (
        <>
          {!compact && (
            <Textarea
              label="Comment"
              optional={!rejecting}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              maxLength={1000}
              hint="Recorded in the audit log with your decision."
              error={
                rejecting && !comment.trim()
                  ? 'Say why you’re rejecting, so the requester knows what to change.'
                  : undefined
              }
            />
          )}
          {item.requiresArm && !arm.armed && (
            <Callout
              tone="info"
              title="Approving needs write access"
              icon={<LockKeyOpenIcon size={18} />}
              action={
                me.canArm ? (
                  <Button size="sm" onClick={openArmDialog}>
                    <LockKeyOpenIcon size={14} aria-hidden />
                    Arm write access
                  </Button>
                ) : undefined
              }
            >
              The steps after this approval change the tenant and run as you, the approver. Arm write access,
              then approve. Rejecting doesn’t need it.
            </Callout>
          )}
          {mutation.isError && (
            <Callout tone="crit" role="alert" title="Your decision wasn’t recorded">
              {(mutation.error as Error).message}
            </Callout>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              intent="ghost"
              pending={mutation.isPending && mutation.variables === 'reject'}
              onClick={() => {
                if (!compact && !comment.trim()) return setRejecting(true);
                mutation.mutate('reject');
              }}
            >
              Reject
            </Button>
            <Approve
              intent="primary"
              pending={mutation.isPending && mutation.variables === 'approve'}
              onClick={() => mutation.mutate('approve')}
            >
              {item.subjectType === 'run' ? 'Approve and continue' : 'Approve'}
            </Approve>
          </div>
        </>
      )}
    </article>
  );
}

/**
 * A manual checklist step (runbooks): instructions, every box ticked, notes, then Mark done. When write steps follow
 * (`requiresArm`), the steps after it run as the person who marks it done, so Mark done needs write access — said up
 * front and locked until armed, like approving such a gate; a refusal (`not_armed`) says the same.
 */
export function ManualStepCard({
  runId,
  stepId,
  title,
  instructions,
  checklist,
  requiresArm = false,
}: {
  runId: string;
  stepId: string;
  title: string;
  instructions: string;
  checklist: string[];
  requiresArm?: boolean;
}) {
  const me = useMe();
  const { arm, openArmDialog } = useShell();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState<boolean[]>(() => checklist.map(() => false));
  const [notes, setNotes] = useState('');
  const [blocked, setBlocked] = useState(false);
  const allChecked = checked.every(Boolean);
  const mutation = useMutation({
    mutationFn: (confirmed: boolean) =>
      api(`/api/runs/${encodeURIComponent(runId)}/manual/${encodeURIComponent(stepId)}`, {
        method: 'POST',
        body: { confirmed, notes: notes.trim() || undefined },
      }),
    onSuccess: (_d, confirmed) => {
      toast({
        tone: confirmed ? 'ok' : 'warn',
        title: confirmed ? `Done: ${title}` : `Marked as not done: ${title}`,
      });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  /** The API refused Mark done without write access (the steps after it write). */
  const refused =
    mutation.isError && mutation.error instanceof ApiRequestError && mutation.error.code === 'not_armed';
  const needsArm = (requiresArm || refused) && !arm.armed;
  // Arming from the prompt removes it (and its button): focus moves on to Mark done.
  const done = useRef<HTMLButtonElement>(null);
  const prompted = useRef(false);
  useEffect(() => {
    if (needsArm) prompted.current = true;
    else if (prompted.current && arm.armed) {
      prompted.current = false;
      done.current?.focus();
    }
  }, [needsArm, arm.armed]);
  const Done = requiresArm ? WriteAction : Button;
  return (
    <div className="flex flex-col gap-3 rounded-(--af-panel-radius) border border-accent bg-panel p-4 shadow-1">
      <p className="af-eyebrow text-accent">Your turn</p>
      <p className="-mt-1.5 text-md font-semibold text-fg">{title}</p>
      <Markdown source={instructions} />
      {checklist.length > 0 && (
        <div role="group" aria-label={`${title} checklist`} className="flex flex-col gap-2">
          {checklist.map((item, i) => (
            <Checkbox
              key={i}
              label={item}
              checked={checked[i]}
              onCheckedChange={(on) => setChecked((all) => all.map((c, j) => (j === i ? on : c)))}
            />
          ))}
        </div>
      )}
      <Textarea
        label="Notes"
        optional={!blocked}
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        hint={
          blocked
            ? 'Say what stopped you; the run records it.'
            : 'Recorded with the step (ticket numbers, what you saw).'
        }
      />
      {/* The steps after this one change the tenant and run as you: marking it done needs write access. */}
      {needsArm && (
        <Callout
          tone="info"
          {...(refused ? { role: 'alert' as const } : {})}
          title="Marking this done needs write access"
          icon={<LockKeyOpenIcon size={18} />}
          action={
            me.canArm ? (
              <Button size="sm" onClick={openArmDialog}>
                <LockKeyOpenIcon size={14} aria-hidden />
                Arm write access
              </Button>
            ) : undefined
          }
        >
          {me.canArm
            ? 'The steps after this one change the tenant and run as you. Arm write access, then mark it done. “I can’t do this” doesn’t need it.'
            : 'The steps after this one change the tenant and run as you, which needs the Portal Operator role. Ask a portal administrator for it, or select “I can’t do this”.'}
        </Callout>
      )}
      {mutation.isError && !refused && (
        <Callout tone="crit" role="alert" title="That wasn’t recorded">
          {(mutation.error as Error).message}
          {mutation.error instanceof ApiRequestError && mutation.error.hint && (
            <span className="mt-1 block">{mutation.error.hint}</span>
          )}
        </Callout>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          intent="ghost"
          pending={mutation.isPending && mutation.variables === false}
          onClick={() => {
            if (!blocked) return setBlocked(true);
            if (notes.trim()) mutation.mutate(false);
          }}
        >
          {blocked && !notes.trim() ? 'Add a note to continue' : 'I can’t do this'}
        </Button>
        <Done
          ref={done}
          intent="primary"
          pending={mutation.isPending && mutation.variables === true}
          aria-disabled={!allChecked || undefined}
          onClick={() => allChecked && mutation.mutate(true)}
        >
          Mark done
        </Done>
      </div>
      {!allChecked && <p className="text-right text-xs text-fg-3">Tick every item to mark the step done.</p>}
    </div>
  );
}
