import { createFileRoute } from '@tanstack/react-router';
import { ScheduleEditorPage } from '../../ops/ScheduleEditorPage';

/** Schedule editor: builds schedule YAML for review (content lives in git). */
export const Route = createFileRoute('/schedules/new')({
  component: ScheduleEditorPage,
});
