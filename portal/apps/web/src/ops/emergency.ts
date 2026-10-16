import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';
import { bool, parser, rec, str } from '../runs/json';

/**
 * Emergency stop (ENG-08):
 *   GET /api/emergency             → { writes, automation: { paused, reason, by, at }, canPause, canResume }
 *   PUT /api/admin/emergency { target: 'writes' | 'automation', paused, reason? } → the same
 * Pausing needs Portal.Admin or Playbook.Approver and a reason; resuming needs Portal.Admin.
 */

export type PauseTarget = 'writes' | 'automation';

export interface PauseState {
  paused: boolean;
  reason: string | null;
  by: string | null;
  at: string | null;
}

export interface EmergencyState {
  writes: PauseState;
  automation: PauseState;
  canPause: boolean;
  canResume: boolean;
}

const pause = (v: unknown): PauseState => {
  const o = rec(v);
  return {
    paused: bool(o.paused) ?? false,
    reason: str(o.reason) ?? null,
    by: str(o.by) ?? null,
    at: str(o.at) ?? null,
  };
};

export const EmergencyParser = parser((input): EmergencyState => {
  const o = rec(input);
  if (!('writes' in o) || !('automation' in o)) throw new TypeError('Expected { writes, automation }');
  return {
    writes: pause(o.writes),
    automation: pause(o.automation),
    canPause: bool(o.canPause) ?? false,
    canResume: bool(o.canResume) ?? false,
  };
});

export const emergencyQuery = queryOptions({
  queryKey: ['emergency'] as const,
  queryFn: ({ signal }) => api('/api/emergency', { schema: EmergencyParser, signal }),
  staleTime: 30_000,
  // `emergency.changed` refetches it at once; polling covers changes made from another process or a dropped stream.
  refetchInterval: 60_000,
  retry: false,
});

export const setPaused = (target: PauseTarget, paused: boolean, reason?: string) =>
  api('/api/admin/emergency', {
    method: 'PUT',
    body: { target, paused, ...(reason ? { reason } : {}) },
    schema: EmergencyParser,
  });

export const PAUSE_COPY: Record<
  PauseTarget,
  { title: string; paused: string; running: string; effect: string }
> = {
  writes: {
    title: 'Changes',
    paused: 'Changes are paused',
    running: 'Changes allowed',
    effect:
      'Every change AdminForge would make — playbooks, runbooks and scheduled jobs — is refused. Reads keep working.',
  },
  automation: {
    title: 'Automation',
    paused: 'Automation is paused',
    running: 'Automation running',
    effect:
      'Schedules, probes and reports don’t run; each skipped occurrence shows in the schedule’s history. Runs already going finish.',
  },
};
