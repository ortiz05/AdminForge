import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  formatRelative,
  formatTimestamp,
  Panel,
  PlayIcon,
  SkeletonText,
  StatusPill,
  StopCircleIcon,
  TextField,
  useToast,
} from '@adminforge/ui';
import { errorDescription } from '../lib/errors';
import { emergencyQuery, PAUSE_COPY, setPaused, type PauseState, type PauseTarget } from './emergency';
import { QueryError } from './ui';

const TARGETS: PauseTarget[] = ['writes', 'automation'];

/** "Paused by avery@example.com 5 min ago: “reason”." */
export function pausedLine(p: PauseState, now = Date.now()): string {
  const by = p.by ? ` by ${p.by}` : '';
  const when = p.at ? ` ${formatRelative(p.at, now)}` : '';
  return `Paused${by}${when}${p.reason ? `: “${p.reason}”` : '.'}`;
}

/**
 * Emergency stop on Admin → Settings: pause every change AdminForge would make, or every schedule, without host access.
 * Pausing (Portal Admin or Playbook Approver) needs a reason everyone sees; resuming is for Portal Admins. Both audited.
 */
export function EmergencyCard() {
  const q = useQuery(emergencyQuery);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [reasons, setReasons] = useState<Record<PauseTarget, string>>({ writes: '', automation: '' });
  const mutation = useMutation({
    mutationFn: (v: { target: PauseTarget; paused: boolean }) =>
      setPaused(v.target, v.paused, v.paused ? reasons[v.target].trim() : undefined),
    onSuccess: (state, v) => {
      queryClient.setQueryData(emergencyQuery.queryKey, state);
      if (v.paused) setReasons((r) => ({ ...r, [v.target]: '' }));
      const copy = PAUSE_COPY[v.target];
      toast({
        tone: v.paused ? 'warn' : 'ok',
        title: v.paused ? copy.paused : `${copy.title} resumed`,
        description: v.paused
          ? copy.effect
          : 'The banner goes away for everyone; the change is in the audit log.',
      });
    },
    onError: (e) => toast({ tone: 'crit', title: 'Nothing changed', description: errorDescription(e) }),
  });

  if (q.data && !q.data.canPause && !q.data.canResume) return null;
  return (
    <Panel
      eyebrow="Emergency stop"
      title="Pause changes or automation"
      description="Takes effect at once in every AdminForge process. Use it while you investigate an incident; nothing in Entra changes."
      flush
    >
      {q.isError ? (
        <div className="px-(--af-pad-panel) py-3">
          <QueryError
            compact
            title="The current state didn’t load"
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </div>
      ) : !q.data ? (
        <div className="px-(--af-pad-panel) py-3" aria-busy="true">
          <SkeletonText lines={3} />
        </div>
      ) : (
        <ul className="flex flex-col">
          {TARGETS.map((target) => {
            const state = q.data[target];
            const copy = PAUSE_COPY[target];
            const pending = mutation.isPending && mutation.variables?.target === target;
            const reason = reasons[target];
            return (
              <li
                key={target}
                className="flex flex-col gap-3 border-t border-line px-(--af-pad-panel) py-3 first:border-t-0"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                  <span className="flex min-w-60 flex-1 flex-col gap-0.5">
                    <span className="font-medium text-fg">{copy.title}</span>
                    <span className="text-xs text-fg-3">{copy.effect}</span>
                  </span>
                  <StatusPill status={state.paused ? 'warn' : 'ok'} size="sm">
                    {state.paused ? 'Paused' : copy.running}
                  </StatusPill>
                </div>
                {state.paused ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 text-sm break-words text-fg-2">
                      <span title={state.at ? formatTimestamp(state.at) : undefined}>
                        {pausedLine(state)}
                      </span>
                    </p>
                    {q.data.canResume ? (
                      <Button pending={pending} onClick={() => mutation.mutate({ target, paused: false })}>
                        <PlayIcon size={14} weight="fill" aria-hidden />
                        Resume {copy.title.toLowerCase()}
                      </Button>
                    ) : (
                      <span className="text-xs text-fg-3">A Portal Admin can resume it.</span>
                    )}
                  </div>
                ) : (
                  q.data.canPause && (
                    <form
                      className="flex flex-col gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (reason.trim().length >= 3) mutation.mutate({ target, paused: true });
                      }}
                    >
                      <div className="flex flex-wrap items-end gap-3">
                        <TextField
                          className="min-w-60 flex-1"
                          label="Reason"
                          aria-describedby={`emergency-${target}-hint`}
                          value={reason}
                          maxLength={500}
                          placeholder="Incident, investigation or change window"
                          onChange={(e) => {
                            const value = e.currentTarget.value;
                            setReasons((r) => ({ ...r, [target]: value }));
                          }}
                        />
                        <Button
                          type="submit"
                          intent="danger"
                          pending={pending}
                          locked={reason.trim().length < 3 ? 'Enter a reason first.' : undefined}
                        >
                          {reason.trim().length >= 3 && (
                            <StopCircleIcon size={14} weight="fill" aria-hidden />
                          )}
                          Pause {copy.title.toLowerCase()}
                        </Button>
                      </div>
                      <p id={`emergency-${target}-hint`} className="text-xs text-fg-3">
                        Shown to everyone signed in and kept in the audit log.
                      </p>
                    </form>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
