import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Button,
  EmptyState,
  ErrorState,
  Kbd,
  LockKeyIcon,
  PageHeader,
  Panel,
  Skeleton,
  SquaresFourIcon,
  modKey,
} from '@adminforge/ui';
import { useShell } from '../app/shell-context';
import { ApiRequestError } from '../lib/api';
import { AppLink } from '../lib/links';
import { definitionQuery } from './api';
import { PageView, type SearchPatch, type SearchUpdate } from './PageView';

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-(--af-gap-grid)" aria-busy="true">
      <div className="flex flex-col gap-2 pb-6">
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-3 w-96" />
      </div>
      <Skeleton shape="block" className="h-24 w-full" />
      <Skeleton shape="block" className="h-96 w-full" />
      <span className="sr-only">Loading page</span>
    </div>
  );
}

/** Not found / no access / failed — each says what happened and what to do (§6.9). */
export function DefinitionError({
  pageKey,
  error,
  onRetry,
}: {
  pageKey: string;
  error: unknown;
  onRetry: () => void;
}) {
  const { openPalette } = useShell();
  const e = error instanceof ApiRequestError ? error : undefined;
  if (e?.status === 404)
    return (
      <>
        <PageHeader
          eyebrow="Not found"
          title="There’s no page at this address"
          description={<code className="text-fg-3">{pageKey}</code>}
        />
        <Panel>
          <EmptyState
            title="Check the link, or jump to a page"
            icon={<SquaresFourIcon size={20} />}
            action={
              <>
                <Button intent="primary" onClick={openPalette}>
                  Open the command palette
                  <Kbd keys={[modKey(), 'K']} />
                </Button>
                <AppLink
                  href="/"
                  className="inline-flex h-(--af-control-h) items-center rounded-md px-3 font-semibold text-accent hover:bg-hover"
                >
                  Go to Overview
                </AppLink>
              </>
            }
          >
            The page may have been renamed or retired, or it isn’t published yet.
          </EmptyState>
        </Panel>
      </>
    );
  if (e?.status === 403)
    return (
      <>
        <PageHeader
          eyebrow="No access"
          title="You don’t have access to this page"
          description={<code className="text-fg-3">{pageKey}</code>}
        />
        <Panel>
          <EmptyState title={e.message} icon={<LockKeyIcon size={20} />}>
            {e.hint ?? 'Ask a Portal Admin to add you to the group for the role this page needs.'}
          </EmptyState>
        </Panel>
      </>
    );
  return (
    <>
      <PageHeader eyebrow="Error" title="This page didn’t load" />
      <Panel>
        <ErrorState
          title="AdminForge couldn’t load the page definition"
          message={(error as Error).message}
          hint={e?.hint ?? 'Try again in a moment. If it keeps failing, the API may be restarting.'}
          code={e?.code}
          correlationId={e?.correlationId}
          action={<Button onClick={onRetry}>Try again</Button>}
        />
      </Panel>
    </>
  );
}

/** `/p/$key`: any published page, dashboard or report; params and table state live in the URL. */
export function ContentPage({ pageKey }: { pageKey: string }) {
  const q = useQuery(definitionQuery(pageKey));
  const search = useRouterState({ select: (s) => s.location.search as SearchPatch });
  const navigate = useNavigate();
  const update: SearchUpdate = useCallback(
    (patch, opts) =>
      navigate({
        to: '.',
        search: ((prev: SearchPatch) =>
          typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }) as never,
        replace: opts?.replace,
      }),
    [navigate],
  );
  const title = q.data?.title;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · AdminForge`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  if (q.isPending) return <PageSkeleton />;
  if (q.isError)
    return <DefinitionError pageKey={pageKey} error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <PageView
      key={`${q.data.id}@${q.data.version}`}
      def={q.data}
      search={search}
      update={update}
      viewId={typeof search.view === 'string' ? search.view : undefined}
    />
  );
}
