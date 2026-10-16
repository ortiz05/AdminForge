import { createFileRoute } from '@tanstack/react-router';
import { ReportsPage } from '../reports/ReportsPage';
import { validateReportsSearch } from '../reports/search';

/** The report catalogue: every report, filterable by area, tag and schedule; details and scheduling in place. */
export const Route = createFileRoute('/reports')({
  validateSearch: validateReportsSearch,
  component: function ReportsRoute() {
    return <ReportsPage search={Route.useSearch()} />;
  },
});
