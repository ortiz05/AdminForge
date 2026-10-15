import { createContext, useContext } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { MeResponse, NavResponse } from '@adminforge/schemas';
import { api, rememberCsrf } from './api';

export const meQuery = queryOptions({
  queryKey: ['me'] as const,
  queryFn: async ({ signal }) => {
    const me = await api('/api/me', { schema: MeResponse, signal });
    rememberCsrf(me.csrf);
    return me;
  },
  staleTime: 60_000,
  refetchOnWindowFocus: true,
});

export const navQuery = queryOptions({
  queryKey: ['nav'] as const,
  queryFn: ({ signal }) => api('/api/nav', { schema: NavResponse, signal }),
  staleTime: 5 * 60_000,
});

/** GET /api/me through TanStack Query: user, roles, mode, armedUntil, csrf, prefs. */
export function useSession() {
  return useQuery(meQuery);
}

export function useNav() {
  return useQuery(navQuery);
}

/** The signed-in session, provided by the shell once /api/me has loaded. */
export const SessionContext = createContext<MeResponse | null>(null);

export function useMe(): MeResponse {
  const me = useContext(SessionContext);
  if (!me) throw new Error('useMe() is only available inside the signed-in shell.');
  return me;
}
