import { createFileRoute } from '@tanstack/react-router';
import { RunbookPage, type RunbookSearch } from '../../runs/RunbookPage';

export const Route = createFileRoute('/runbooks/$key')({
  // `run` opens a run; anything else (`inputs=<base64url>`, `userId=…`) prefills the start form (read raw by the page).
  validateSearch: (s: Record<string, unknown>): RunbookSearch => ({
    run: typeof s.run === 'string' && /^[\w-]{1,64}$/.test(s.run) ? s.run : undefined,
  }),
  component: function RunbookRoute() {
    const { key } = Route.useParams();
    return <RunbookPage key={key} runbookKey={key} search={Route.useSearch()} />;
  },
});
