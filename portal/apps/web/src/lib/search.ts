import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, isRecord } from './api';

/** GET /api/search?q= — pages, reports, playbooks, and directory/Azure objects for the command palette. */
export type SearchType =
  'page' | 'dashboard' | 'report' | 'playbook' | 'runbook' | 'user' | 'group' | 'device' | 'app' | 'resource';

export interface SearchResult {
  type: SearchType;
  title: string;
  subtitle?: string;
  href: string;
  external?: boolean;
  icon?: string;
}

const TYPES = new Set<string>([
  'page',
  'dashboard',
  'report',
  'playbook',
  'runbook',
  'user',
  'group',
  'device',
  'app',
  'resource',
]);

function readSearch(input: unknown): SearchResult[] {
  const list = isRecord(input) && Array.isArray(input.results) ? input.results : [];
  return list.filter(isRecord).flatMap((r) =>
    typeof r.title === 'string' && typeof r.href === 'string' && TYPES.has(String(r.type))
      ? [
          {
            type: r.type as SearchType,
            title: r.title,
            href: r.href,
            ...(typeof r.subtitle === 'string' ? { subtitle: r.subtitle } : {}),
            ...(r.external === true ? { external: true } : {}),
            ...(typeof r.icon === 'string' ? { icon: r.icon } : {}),
          },
        ]
      : [],
  );
}

/** Palette sections, in display order. */
export const SEARCH_SECTIONS: Array<{ heading: string; types: SearchType[]; icon: string }> = [
  { heading: 'Users', types: ['user'], icon: 'user' },
  { heading: 'Groups', types: ['group'], icon: 'users-three' },
  { heading: 'Devices', types: ['device'], icon: 'desktop' },
  { heading: 'Applications', types: ['app'], icon: 'app-window' },
  { heading: 'Azure resources', types: ['resource'], icon: 'cube' },
  { heading: 'Pages and dashboards', types: ['page', 'dashboard'], icon: 'squares-four' },
  { heading: 'Reports', types: ['report'], icon: 'chart-bar' },
  { heading: 'Playbooks and runbooks', types: ['playbook', 'runbook'], icon: 'lightning' },
];

export const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

/** Debounced server search; `pending` covers both the debounce and the request. */
export function useSearch(q: string): {
  results: SearchResult[];
  pending: boolean;
  error: boolean;
  query: string;
} {
  const trimmed = q.trim();
  const [debounced, setDebounced] = useState(trimmed);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(trimmed), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [trimmed]);
  const enabled = debounced.length >= MIN_QUERY;
  const query = useQuery({
    queryKey: ['search', debounced] as const,
    queryFn: ({ signal }) =>
      api(`/api/search?q=${encodeURIComponent(debounced)}`, { schema: { parse: readSearch }, signal }),
    enabled,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const active = trimmed.length >= MIN_QUERY;
  return {
    results: active && enabled ? (query.data ?? []) : [],
    pending: active && (debounced !== trimmed || query.isFetching),
    error: active && query.isError,
    query: debounced,
  };
}
