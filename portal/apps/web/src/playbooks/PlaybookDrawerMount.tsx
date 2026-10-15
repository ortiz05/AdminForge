import { lazy, Suspense } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Drawer, Skeleton } from '@adminforge/ui';

// The drawer, its form, launch parsing and JSONata stay out of the first load: they arrive when a playbook is launched.
const PlaybookDrawer = lazy(() => import('./PlaybookDrawer'));

/**
 * Shell mount point: opens the playbook drawer whenever the URL carries `?playbook=` (see ./url.ts for the params
 * pages, row actions and bulk actions produce).
 */
export function PlaybookDrawerMount() {
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const playbook = typeof search.playbook === 'string' && search.playbook ? search.playbook : undefined;
  if (!playbook) return null;
  return (
    <Suspense
      fallback={
        <Drawer open onOpenChange={() => {}} modal={false} docked className="w-160" eyebrow="Playbook" title="Loading playbook…">
          <Skeleton className="h-16 w-full" shape="block" />
        </Drawer>
      }
    >
      <PlaybookDrawer key={`${playbook}:${String(search.items ?? '')}`} search={search} />
    </Suspense>
  );
}
