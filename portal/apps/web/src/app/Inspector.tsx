import { useNavigate, useSearch } from '@tanstack/react-router';
import { Drawer, EmptyState, IdChip, MagnifyingGlassIcon, shorten } from '@adminforge/ui';

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
 * Entity detail without leaving the list. Deep-linkable through `?inspect=`; non-modal, so the list stays usable.
 * Entity pages (Phase 5) render their detail here; until then it says what will appear.
 */
export function Inspector() {
  const search = useSearch({ strict: false }) as { inspect?: string };
  const navigate = useNavigate();
  const value = typeof search.inspect === 'string' ? search.inspect : undefined;
  const target = value ? parseInspect(value) : null;

  const close = () =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, inspect: undefined }),
      replace: true,
    });

  return (
    <Drawer
      open={Boolean(target)}
      onOpenChange={(open) => !open && close()}
      modal={false}
      docked
      eyebrow="Inspector"
      title={target ? `${target.label} ${shorten(target.id)}` : 'Inspector'}
      description="Details open here without leaving the list."
    >
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
