import { createFileRoute } from '@tanstack/react-router';
import { SchedulesPage } from '../../ops/SchedulesPage';

export const Route = createFileRoute('/schedules/')({
  component: SchedulesPage,
});
