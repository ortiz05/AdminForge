import { useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Button, ErrorState, SkeletonText } from '@adminforge/ui';
import { ApiRequestError, loginUrl } from '../lib/api';
import { browser } from '../lib/browser';
import { definitionQuery } from './api';
import { PageView, type SearchPatch, type SearchUpdate } from './PageView';
import { INSPECT_PREFIX, type InspectState } from './url-state';

export interface InspectorPageProps {
  target: InspectState;
  /** The entity's name once loaded (drawer title). */
  onTitle: (title: string | undefined) => void;
  /** The page's own title (drawer eyebrow), e.g. "User". */
  onPageTitle: (title: string | undefined) => void;
  /** The entity page on its own (drawer header "Open full page"); undefined until the page has loaded. */
  onFullPageHref: (href: string | undefined) => void;
}

/**
 * An entity page inside the inspector drawer. Its params live under `i.<name>` in the URL (so the inspector is
 * deep-linkable next to the list's own params) and its tab under `itab`.
 */
export default function InspectorPage({ target, onTitle, onPageTitle, onFullPageHref }: InspectorPageProps) {
  const q = useQuery(definitionQuery(target.page));
  const navigate = useNavigate();
  const itab = useRouterState({ select: (s) => (s.location.search as SearchPatch).itab });
  // The shell reads `target` from the URL on every render (a new object each time): keyed by its value, the page gets
  // new params only when the URL changes. Otherwise a title it reports re-renders the shell, which gives it a new data
  // scope, which evaluates the title again — a loop that froze the browser on the sign-in page.
  const paramsKey = JSON.stringify(target.params);
  const search = useMemo(
    () => ({
      ...(JSON.parse(paramsKey) as Record<string, unknown>),
      ...(typeof itab === 'string' ? { tab: itab } : {}),
    }),
    [paramsKey, itab],
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
        action={
          // A sign-in problem isn't fixed by asking again: offer the sign-in (not taken automatically after a loop).
          e?.status === 401 && e.login ? (
            <Button size="sm" intent="primary" onClick={() => browser.assign(loginUrl(e.login!))}>
              Sign in again
            </Button>
          ) : e?.status === 404 ? undefined : (
            <Button size="sm" onClick={() => void q.refetch()}>
              Try again
            </Button>
          )
        }
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
      onFullPageHref={onFullPageHref}
    />
  );
}
