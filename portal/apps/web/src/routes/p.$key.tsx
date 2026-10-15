import { createFileRoute } from '@tanstack/react-router';
import { ContentPage } from '../renderer/PageRoute';
import { sanitizeSearch } from '../renderer/inspect-url';

/**
 * Content pages: `/p/<key>` renders any published page, dashboard or report (e.g. /p/identity.users,
 * /p/identity.user?id=…). Search params carry page params, table state, the saved view and the inspector.
 */
export const Route = createFileRoute('/p/$key')({
  validateSearch: (search: Record<string, unknown>) => sanitizeSearch(search),
  component: ContentRoute,
});

function ContentRoute() {
  const { key } = Route.useParams();
  return <ContentPage pageKey={key} />;
}
