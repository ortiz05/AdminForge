import { useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ErrorState, SkeletonText } from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import { definitionQuery } from './api';
import { PageView, type SearchPatch, type SearchUpdate } from './PageView';
import { INSPECT_PREFIX, type InspectState } from './url-state';

export interface InspectorPageProps {
  target: InspectState;
  /** The entity's name once loaded (drawer title). */
  onTitle: (title: string | undefined) => void;
  /** The page's own title (drawer eyebrow), e.g. "User". */
  onPageTitle: (title: string | undefined) => void;
}

/**
 * An entity page inside the inspector drawer. Its params live under `i.<name>` in the URL (so the inspector is
 * deep-linkable next to the list's own params) and its tab under `itab`.
 */
export default function InspectorPage({ target, onTitle, onPageTitle }: InspectorPageProps) {
  const q = useQuery(definitionQuery(target.page));
  const navigate = useNavigate();
  const itab = useRouterState({ select: (s) => (s.location.search as SearchPatch).itab });
  const search = useMemo(
    () => ({ ...target.params, ...(typeof itab === 'string' ? { tab: itab } : {}) }),
    [target.params, itab],
  );
  const pageTitle = q.data?.title;
  useEffect(() => onPageTitle(pageTitle), [pageTitle, onPageTitle]);

  const update: SearchUpdate = useCallback(
    (patch, opts) =>
      navigate({
        to: '.',
        search: ((prev: SearchPatch) => {
          const mine: SearchPatch = {};
          for (const [k, v] of Object.entries(prev))
            if (k.startsWith(INSPECT_PREFIX)) mine[k.slice(INSPECT_PREFIX.length)] = v;
          if (typeof prev.itab === 'string') mine.tab = prev.itab;
          const next = typeof patch === 'function' ? patch(mine) : { ...mine, ...patch };
          const out: SearchPatch = {};
          for (const [k, v] of Object.entries(prev))
            if (!k.startsWith(INSPECT_PREFIX) && k !== 'itab') out[k] = v;
          for (const [k, v] of Object.entries(next)) {
            if (k.includes('.')) continue; // table state stays local in the inspector
            if (k === 'tab') out.itab = v;
            else out[`${INSPECT_PREFIX}${k}`] = v;
          }
          return out;
        }) as never,
        replace: opts?.replace ?? true,
      }),
    [navigate],
  );

  if (q.isPending) return <SkeletonText lines={6} />;
  if (q.isError) {
    const e = q.error instanceof ApiRequestError ? q.error : undefined;
    return (
      <ErrorState
        compact
        title={e?.status === 404 ? 'This page isn’t published' : 'The details didn’t load'}
        message={(q.error as Error).message}
        hint={e?.hint}
        code={e?.code}
        correlationId={e?.correlationId}
      />
    );
  }
  return (
    <PageView
      key={`${q.data.id}@${q.data.version}`}
      def={q.data}
      search={search}
      update={update}
      inspector
      onTitle={onTitle}
    />
  );
}
