import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Playbook } from '@adminforge/schemas';
import { Button, Drawer, Skeleton, SkeletonText } from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import { QueryError } from '../ops/ui';
import { definitionQuery, type LoadedDefinition } from './contracts';
import { PlaybookActions, PlaybookMeta, PlaybookSections } from './PlaybookView';
import { usePlaybookFlow, type SearchPatch } from './usePlaybookFlow';
import { parseLaunch, withoutPlaybook, type ParsedLaunch } from './url';

const DRAWER_CLASS = 'w-160';

function Loaded({
  loaded,
  launch,
  onClose,
}: {
  loaded: LoadedDefinition<Playbook>;
  launch: ParsedLaunch;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const setSearch = useCallback(
    (patch: SearchPatch) =>
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
        replace: true,
      }),
    [navigate],
  );
  const flow = usePlaybookFlow({
    def: loaded.def,
    version: loaded.version,
    launch,
    setSearch,
    onStarted: (runId) => void navigate({ to: '/runs/$id', params: { id: runId } }),
  });
  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      modal={false}
      docked
      className={DRAWER_CLASS}
      eyebrow={flow.bulk ? 'Bulk playbook' : 'Playbook'}
      title={loaded.def.title}
      description={
        <span className="flex flex-col gap-1.5">
          {loaded.def.summary && <span>{loaded.def.summary}</span>}
          <PlaybookMeta flow={flow} version={loaded.version} />
        </span>
      }
      footer={<PlaybookActions flow={flow} />}
    >
      <PlaybookSections flow={flow} problems={launch.problems} />
    </Drawer>
  );
}

/**
 * The playbook template (§6.6) as a side sheet over whatever page launched it. Non-modal, so the session rail
 * (Arm write access, the countdown) stays usable while it is open; Escape or × closes it.
 */
export default function PlaybookDrawer({ search }: { search: Record<string, unknown> }) {
  const navigate = useNavigate();
  // Read once when the drawer opens: afterwards the form owns the inputs and writes them back to the URL.
  const [launch] = useState(() => parseLaunch(search)!);
  const q = useQuery({ ...definitionQuery<Playbook>('playbook', launch.key), enabled: launch.keyValid });
  const close = useCallback(
    () =>
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => withoutPlaybook(prev),
        replace: true,
      }),
    [navigate],
  );

  if (q.data) return <Loaded loaded={q.data} launch={launch} onClose={close} />;

  const notFound = q.error instanceof ApiRequestError && q.error.status === 404;
  return (
    <Drawer
      open
      onOpenChange={(open) => !open && close()}
      modal={false}
      docked
      className={DRAWER_CLASS}
      eyebrow="Playbook"
      title={q.isError ? 'Playbook unavailable' : 'Loading playbook…'}
      description={<code className="font-mono text-xs">{launch.key}</code>}
      footer={
        <Button intent="ghost" onClick={close}>
          Close
        </Button>
      }
    >
      {q.isError ? (
        <QueryError
          title={notFound ? 'There’s no published playbook with this key' : 'The playbook didn’t load'}
          error={
            notFound
              ? new ApiRequestError(
                  404,
                  'definition_not_found',
                  `Nothing is published as “${launch.key}”.`,
                  'Check the link, or ask the content owner whether it was renamed or retired.',
                )
              : q.error
          }
          onRetry={notFound ? undefined : () => void q.refetch()}
        />
      ) : !launch.keyValid ? (
        <QueryError title="This link doesn’t name a playbook" error={new Error(launch.problems.join(' '))} />
      ) : (
        <div className="flex flex-col gap-5" aria-busy="true">
          <Skeleton className="h-16 w-full" shape="block" />
          <SkeletonText lines={2} />
          <Skeleton className="h-9 w-full" shape="block" />
          <Skeleton className="h-9 w-full" shape="block" />
          <Skeleton className="h-24 w-full" shape="block" />
        </div>
      )}
    </Drawer>
  );
}
