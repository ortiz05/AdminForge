import { createFileRoute } from '@tanstack/react-router';
import { AuditPage, type AuditSearch } from '../ops/AuditPage';

const text = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim() && v.length <= max ? v : undefined;
const date = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 32) : undefined;

export const Route = createFileRoute('/audit')({
  validateSearch: (s: Record<string, unknown>): AuditSearch => ({
    actor: text(s.actor),
    action: text(s.action),
    from: date(s.from),
    to: date(s.to),
    event:
      typeof s.event === 'number'
        ? s.event
        : typeof s.event === 'string' && /^\d+$/.test(s.event)
          ? Number(s.event)
          : undefined,
  }),
  component: function AuditRoute() {
    return <AuditPage search={Route.useSearch()} />;
  },
});
