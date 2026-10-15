import { createFileRoute } from '@tanstack/react-router';
import { SchedulePage } from '../../ops/SchedulePage';

export const Route = createFileRoute('/schedules/$key')({
  component: function ScheduleRoute() {
    const { key } = Route.useParams();
    return <SchedulePage key={key} scheduleKey={key} />;
  },
});
