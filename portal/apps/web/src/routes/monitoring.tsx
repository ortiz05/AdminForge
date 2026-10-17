import { createFileRoute } from '@tanstack/react-router';
import { MonitoringPage, type MonitoringSearch } from '../ops/MonitoringPage';

export const Route = createFileRoute('/monitoring')({
  validateSearch: (s: Record<string, unknown>): MonitoringSearch => ({
    probe: typeof s.probe === 'string' && s.probe.length <= 200 ? s.probe : undefined,
    show: s.show === 'problems' ? 'problems' : undefined,
    group: typeof s.group === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(s.group) ? s.group : undefined,
    by: s.by === 'check' ? 'check' : undefined,
  }),
  component: function MonitoringRoute() {
    return <MonitoringPage search={Route.useSearch()} />;
  },
});
