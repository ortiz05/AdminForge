import { lazy, Suspense, useCallback, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Drawer, EmptyState, IdChip, MagnifyingGlassIcon, SkeletonText, shorten } from '@adminforge/ui';
import { readInspect, withoutInspect } from '../renderer/inspect-url';

// The renderer (widgets, expressions) stays out of the first load: it arrives when something is inspected.
const InspectorPage = lazy(() => import('../renderer/InspectorPage'));

const KIND_LABEL: Record<string, string> = {
  user: 'User',
  group: 'Group',
  device: 'Device',
  app: 'Application',
  sp: 'Enterprise app',
  resource: 'Azure resource',
  run: 'Run',
};

/** `?inspect=user:<id>` → kind + id. Anything else is shown as-is. */
export function parseInspect(value: string): { kind: string; label: string; id: string } {
  const i = value.indexOf(':');
  const kind = i > 0 ? value.slice(0, i) : 'item';
  const id = i > 0 ? value.slice(i + 1) : value;
  return { kind, label: KIND_LABEL[kind] ?? 'Item', id };
}

/**
 * Entity detail without leaving the list. Deep-linkable and non-modal, so the list stays usable:
 *   ?inspect=page:<entity page key>&i.<param>=…   renders that content page (e.g. page:identity.user&i.id=…)
 *   ?inspect=<kind>:<id>                           an object with no entity page yet
 */
export function Inspector() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const [entityTitle, setEntityTitle] = useState<string | undefined>();
  const [pageTitle, setPageTitle] = useState<string | undefined>();
  const page = readInspect(search);
  const value = typeof search.inspect === 'string' ? search.inspect : undefined;
  const target = !page && value ? parseInspect(value) : null;
  const open = Boolean(page || target);
  const onTitle = useCallback((t: string | undefined) => setEntityTitle(t), []);
  const onPageTitle = useCallback((t: string | undefined) => setPageTitle(t), []);

  const close = () =>
    void navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => withoutInspect(prev)) as never,
      replace: true,
    });

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && close()}
      modal={false}
      docked
      eyebrow={page ? `Inspector${pageTitle ? ` · ${pageTitle}` : ''}` : 'Inspector'}
      title={page ? (entityTitle ?? pageTitle ?? 'Loading…') : target ? `${target.label} ${shorten(target.id)}` : 'Inspector'}
      description={page ? undefined : 'Details open here without leaving the list.'}
    >
      {page && (
        <Suspense fallback={<SkeletonText lines={6} />}>
          <InspectorPage key={`${page.page}:${JSON.stringify(page.params)}`} target={page} onTitle={onTitle} onPageTitle={onPageTitle} />
        </Suspense>
      )}
      {target && (
        <div className="flex flex-col gap-4">
          <IdChip value={target.id} label="Object ID" full />
          <EmptyState
            compact
            title={`${target.label} details arrive with the ${target.label.toLowerCase()} pages`}
            icon={<MagnifyingGlassIcon size={18} />}
          >
            Overview, membership, sign-ins and actions for this {target.label.toLowerCase()} will show here.
          </EmptyState>
        </div>
      )}
    </Drawer>
  );
}
