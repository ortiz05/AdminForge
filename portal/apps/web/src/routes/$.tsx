import { createFileRoute } from '@tanstack/react-router';
import { NotFoundPage } from '../pages/NotFoundPage';

/** Any path no route serves: the designed not-found state. */
export const Route = createFileRoute('/$')({
  component: NotFoundPage,
});
