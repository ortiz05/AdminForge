import { createFileRoute } from '@tanstack/react-router';
import { PlaybookPage, type PlaybookPageSearch } from '../../playbooks/PlaybookPage';

const str = (v: unknown) => (typeof v === 'string' && v.length <= 64 * 1024 ? v : undefined);

export const Route = createFileRoute('/playbooks/$key')({
  validateSearch: (s: Record<string, unknown>): PlaybookPageSearch => ({
    inputs: str(s.inputs),
    items: str(s.items),
    preview: str(s.preview),
  }),
  component: function PlaybookRoute() {
    const { key } = Route.useParams();
    return <PlaybookPage key={key} playbookKey={key} search={Route.useSearch()} />;
  },
});
