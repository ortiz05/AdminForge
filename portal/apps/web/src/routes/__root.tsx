import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from '../app/AppShell';

export interface RouterContext {
  queryClient: QueryClient;
}

/** `?inspect=kind:id` is global: any page can open the inspector, and the link can be shared. */
export interface RootSearch {
  inspect?: string;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    inspect: typeof search.inspect === 'string' && search.inspect.length <= 300 ? search.inspect : undefined,
  }),
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
