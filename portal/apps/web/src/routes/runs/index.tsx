import { createFileRoute } from '@tanstack/react-router';
import { RunsPage, type RunsSearch } from '../../runs/RunsPage';

export const Route = createFileRoute('/runs/')({
  validateSearch: (s: Record<string, unknown>): RunsSearch => ({
    scope: s.scope === 'all' ? 'all' : s.scope === 'mine' ? 'mine' : undefined,
    status: typeof s.status === 'string' && /^[a-z_,]{1,120}$/.test(s.status) ? s.status : undefined,
    // Not `playbook`: that param opens the playbook drawer on any page.
    definition: typeof s.definition === 'string' && s.definition.length <= 200 ? s.definition : undefined,
  }),
  component: function RunsRoute() {
    return <RunsPage search={Route.useSearch()} />;
  },
});
