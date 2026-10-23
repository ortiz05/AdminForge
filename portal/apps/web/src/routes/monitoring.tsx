import { createFileRoute } from '@tanstack/react-router';
import { listParam } from '../ops/monitoring-model';
import { MonitoringPage, type MonitoringSearch } from '../ops/MonitoringPage';

export const Route = createFileRoute('/monitoring')({
  validateSearch: (s: Record<string, unknown>): MonitoringSearch => ({
    probe: typeof s.probe === 'string' && s.probe.length <= 200 ? s.probe : undefined,
    show: s.show === 'problems' ? 'problems' : undefined,
    group: listParam(s.group),
    fn: listParam(s.fn),
    tag: listParam(s.tag),
    q: typeof s.q === 'string' && s.q.trim() && s.q.length <= 100 ? s.q : undefined,
    by: s.by === 'check' ? 'check' : undefined,
  }),
  component: function MonitoringRoute() {
    return <MonitoringPage search={Route.useSearch()} />;
  },
});
