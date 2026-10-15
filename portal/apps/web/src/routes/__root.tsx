import { createRootRouteWithContext, Outlet, useRouterState } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AppShell } from '../app/AppShell';
import { PUBLIC_PATHS } from '../pages/public/PublicPage';

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
  component: RootLayout,
});

/** Signed-out and sign-in problem pages render without the shell, which would redirect to sign-in. */
function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (PUBLIC_PATHS.has(pathname)) return <Outlet />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
