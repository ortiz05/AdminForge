import { createFileRoute } from '@tanstack/react-router';
import { QueryStudioPage, type QuerySearch } from '../query/QueryStudioPage';

const SOURCES = ['resourceGraph', 'logAnalytics', 'advancedHunting'] as const;

export const Route = createFileRoute('/query')({
  // `?source=logAnalytics&q=…` deep-links a query (kept small; the page module loads on demand).
  validateSearch: (s: Record<string, unknown>): QuerySearch => ({
    source: (SOURCES as readonly unknown[]).includes(s.source)
      ? (s.source as QuerySearch['source'])
      : undefined,
    q: typeof s.q === 'string' && s.q.trim() && s.q.length <= 8000 ? s.q : undefined,
  }),
  component: function QueryRoute() {
    return <QueryStudioPage search={Route.useSearch()} />;
  },
});
