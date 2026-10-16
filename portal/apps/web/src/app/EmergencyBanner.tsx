import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { StopCircleIcon } from '@adminforge/ui';
import { emergencyQuery } from '../ops/emergency';
import { pausedLine } from '../ops/EmergencyCard';
import { Callout } from '../ops/ui';
import { usePortalEvent } from '../runs/event-stream';

/**
 * Shown on every page while an administrator has paused changes or automation (emergency stop), so nobody wonders
 * why a playbook or a schedule didn't do anything. Updates live (`emergency.changed`), polls as a fallback.
 */
export function EmergencyBanner() {
  const queryClient = useQueryClient();
  const q = useQuery(emergencyQuery);
  usePortalEvent(
    'emergency.changed',
    () => void queryClient.invalidateQueries({ queryKey: emergencyQuery.queryKey }),
  );
  const s = q.data;
  if (!s || (!s.writes.paused && !s.automation.paused)) return null;
  const both = s.writes.paused && s.automation.paused;
  const title = both
    ? 'Changes and automation are paused'
    : s.writes.paused
      ? 'Changes are paused'
      : 'Automation is paused';
  return (
    <div className="mb-6">
      <Callout
        tone="warn"
        role="status"
        icon={<StopCircleIcon size={18} weight="fill" />}
        title={title}
        action={
          (s.canPause || s.canResume) && (
            <Link
              to="/settings"
              className="text-sm font-medium text-accent underline-offset-2 hover:underline"
            >
              Emergency stop settings
            </Link>
          )
        }
      >
        {s.writes.paused && (
          <p>
            AdminForge refuses every change (playbooks, runbooks, scheduled jobs); reads keep working.{' '}
            {pausedLine(s.writes)}
          </p>
        )}
        {s.automation.paused && (
          <p>Schedules don’t run until automation is resumed. {pausedLine(s.automation)}</p>
        )}
      </Callout>
    </div>
  );
}
