import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Playbook } from '@adminforge/schemas';
import { EmptyState, PageHeader, Panel, Skeleton, SkeletonText } from '@adminforge/ui';
import { RouterLink } from '../app/RouterLink';
import { ApiRequestError } from '../lib/api';
import { QueryError, useDocumentTitle } from '../ops/ui';
import { definitionQuery, type LoadedDefinition } from './contracts';
import { PlaybookActions, PlaybookMeta, PlaybookSections } from './PlaybookView';
import { usePlaybookFlow, type SearchPatch } from './usePlaybookFlow';
import { parseLaunch } from './url';

export interface PlaybookPageSearch {
  inputs?: string;
  items?: string;
  preview?: string;
}

function Loaded({ loaded, search }: { loaded: LoadedDefinition<Playbook>; search: PlaybookPageSearch }) {
  const navigate = useNavigate();
  // Read once: the form owns the values after mount and writes them back to the URL.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const launch = useMemo(() => parseLaunch({ playbook: loaded.def.id, ...search })!, [loaded.def.id]);
  const setSearch = useCallback(
    (patch: SearchPatch) =>
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
        replace: true,
      }),
    [navigate],
  );
  const flow = usePlaybookFlow({ def: loaded.def, version: loaded.version, launch, setSearch });
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Playbooks' }, { label: loaded.def.title }]}
        linkAs={RouterLink}
        eyebrow={flow.bulk ? 'Bulk playbook' : 'Playbook'}
        title={loaded.def.title}
        description={loaded.def.summary}
        meta={<PlaybookMeta flow={flow} version={loaded.version} />}
      />
      <Panel
        className="max-w-4xl"
        eyebrow={flow.writes ? 'Write playbook' : 'Read playbook'}
        title="Inputs, preview and run"
        footer={<PlaybookActions flow={flow} />}
      >
        <PlaybookSections flow={flow} problems={launch.problems} />
      </Panel>
    </>
  );
}

/** `/playbooks/:key` — the playbook template as a page (navigation links here; pages open the drawer instead). */
export function PlaybookPage({ playbookKey, search }: { playbookKey: string; search: PlaybookPageSearch }) {
  const q = useQuery(definitionQuery<Playbook>('playbook', playbookKey));
  useDocumentTitle(q.data?.def.title ?? 'Playbook');
  if (q.data) return <Loaded loaded={q.data} search={search} />;
  if (q.isError) {
    const notFound = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <>
        <PageHeader eyebrow="Playbook" title={notFound ? 'Playbook not found' : 'Playbook'} />
        <Panel>
          {notFound ? (
            <EmptyState title={`Nothing is published as “${playbookKey}”`}>
              Check the link, or ask the content owner whether it was renamed or retired.
            </EmptyState>
          ) : (
            <QueryError title="The playbook didn’t load" error={q.error} onRetry={() => void q.refetch()} />
          )}
        </Panel>
      </>
    );
  }
  return (
    <div className="flex max-w-4xl flex-col gap-6" aria-busy="true">
      <Skeleton className="h-8 w-80" />
      <SkeletonText lines={2} />
      <Skeleton shape="block" className="h-64 w-full" />
    </div>
  );
}
