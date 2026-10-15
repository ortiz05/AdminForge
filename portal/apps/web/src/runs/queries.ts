import { api } from '../lib/api';
import { RunDetailResponse, RunListResponse } from './contracts';
import { query } from './json';

/** GET /api/runs/:id */
export const runDetailQuery = (id: string) => ({
  queryKey: ['runs', 'detail', id] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api(`/api/runs/${encodeURIComponent(id)}`, { schema: RunDetailResponse, signal }),
});

export interface RunsFilter {
  scope: 'mine' | 'all';
  status?: string;
  playbook?: string;
}

/** GET /api/runs?scope=&status=&playbook=&cursor= (one page). */
export const fetchRunsPage = (filter: RunsFilter, cursor: string | null, signal?: AbortSignal) =>
  api(
    `/api/runs${query({ scope: filter.scope, status: filter.status, playbook: filter.playbook, cursor })}`,
    {
      schema: RunListResponse,
      signal,
    },
  );
