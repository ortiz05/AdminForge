import { createFileRoute } from '@tanstack/react-router';
import { ApprovalsPage, type ApprovalsSearch } from '../runs/ApprovalsPage';

const STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

export const Route = createFileRoute('/approvals')({
  validateSearch: (s: Record<string, unknown>): ApprovalsSearch => ({
    status: STATUSES.find((x) => x === s.status),
  }),
  component: function ApprovalsRoute() {
    return <ApprovalsPage search={Route.useSearch()} />;
  },
});
