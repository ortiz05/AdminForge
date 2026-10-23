import { Link } from '@tanstack/react-router';
import { Badge } from '@adminforge/ui';
import type { ScheduleItem } from './schedules';

/**
 * A schedule's name in a table (Schedules, Monitoring): its title linking to its page, its key, and whether it changes
 * the tenant or was created in the portal.
 */
export function ScheduleTitle({ s }: { s: ScheduleItem }) {
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <Link
        to="/schedules/$key"
        params={{ key: s.key }}
        className="truncate font-medium text-fg hover:underline"
        title={s.title}
      >
        {s.title}
      </Link>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-fg-3">
        <span className="truncate">{s.key}</span>
        {s.writeCapable && (
          <Badge tone="outline" className="h-4 font-body">
            Changes tenant
          </Badge>
        )}
        {s.source === 'portal' && (
          <Badge
            tone="outline"
            className="h-4 font-body"
            title={s.createdBy ? `Created in the portal by ${s.createdBy}` : 'Created in the portal'}
          >
            Created in portal
            {s.createdBy && <span className="sr-only"> by {s.createdBy}</span>}
          </Badge>
        )}
      </span>
    </span>
  );
}
