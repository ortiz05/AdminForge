import { createFileRoute } from '@tanstack/react-router';
import { SchedulePage } from '../../ops/SchedulePage';

export const Route = createFileRoute('/schedules/$key')({
  // `signedIn=1`: back from the Entra sign-in for a schedule that uses its creator's access.
  validateSearch: (s: Record<string, unknown>): { signedIn?: true } =>
    s.signedIn === 1 || s.signedIn === '1' || s.signedIn === true ? { signedIn: true } : {},
  component: function ScheduleRoute() {
    const { key } = Route.useParams();
    const { signedIn } = Route.useSearch();
    return <SchedulePage key={key} scheduleKey={key} signedIn={signedIn === true} />;
  },
});
