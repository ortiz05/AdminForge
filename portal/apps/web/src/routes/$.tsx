import { createFileRoute } from '@tanstack/react-router';
import { ComingSoonPage } from '../pages/ComingSoonPage';

/** Any path not built yet: explain what the page will do, or say it doesn't exist. */
export const Route = createFileRoute('/$')({
  component: ComingSoonPage,
});
