import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { ToastProvider } from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import { routeTree } from '../routeTree.gen';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Client errors (4xx) won't fix themselves; retry only network and server failures, once.
        retry: (count, error) =>
          count < 1 && !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500),
      },
    },
  });
}

/** The app's router. `initialPath` renders at a path without a browser URL (tests, previews). */
export function createAppRouter(queryClient: QueryClient, { initialPath }: { initialPath?: string } = {}) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    history: initialPath ? createMemoryHistory({ initialEntries: [initialPath] }) : undefined,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

/** Providers every screen needs: data cache, toasts, routing. */
export function App({ router, queryClient }: { router: AppRouter; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
