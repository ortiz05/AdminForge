import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SavedViewsSpec } from '@adminforge/schemas';
import {
  BookmarkSimpleIcon,
  Button,
  CaretDownIcon,
  CheckIcon,
  ConfirmDialog,
  Dialog,
  FloppyDiskIcon,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  ShareNetworkIcon,
  StarIcon,
  Switch,
  TextField,
  TrashIcon,
  useToast,
} from '@adminforge/ui';
import { ApiRequestError } from '../lib/api';
import { createView, deleteView, updateView, viewsQuery, type SavedViewItem } from './api';

/** What a saved view stores: page params and table state (the same keys the URL carries). */
export interface ViewState {
  params: Record<string, unknown>;
  table: Record<string, unknown>;
}

const DEFAULTS_KEY = 'adminforge.defaultViews';

/** The user's default view per page (a per-browser convenience; the views themselves live on the server). */
export function readDefaultView(page: string): string | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? '{}') as Record<string, string>;
    return typeof all[page] === 'string' ? all[page] : undefined;
  } catch {
    return undefined;
  }
}

function writeDefaultView(page: string, id: string | undefined) {
  try {
    const all = JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? '{}') as Record<string, string>;
    if (id) all[page] = id;
    else delete all[page];
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the default simply isn't remembered.
  }
}

export const presetId = (name: string) => `preset:${name}`;

/** Order-insensitive comparison of two view states. */
export function sameState(a: ViewState, b: ViewState): boolean {
  const norm = (o: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '').sort(([x], [y]) => x.localeCompare(y))));
  return norm(a.params) === norm(b.params) && norm(a.table) === norm(b.table);
}

export function viewStateOf(v: SavedViewItem): ViewState {
  const s = v.state as Partial<ViewState>;
  return { params: s.params && typeof s.params === 'object' ? s.params : {}, table: s.table && typeof s.table === 'object' ? s.table : {} };
}

export interface ViewsMenuProps {
  page: string;
  spec: SavedViewsSpec | undefined;
  /** Built-in views from the definition, already turned into states. */
  presets: Array<{ name: string; state: ViewState }>;
  current: ViewState;
  activeId: string | undefined;
  onApply: (id: string | undefined, state: ViewState) => void;
}

/**
 * Saved views (R9): built-in presets, the user's views and views others shared. Save the current filters, columns
 * and sort as a view; update, share, delete, or make one the default for this page.
 */
export function ViewsMenu({ page, spec, presets, current, activeId, onApply }: ViewsMenuProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const views = useQuery(viewsQuery(page));
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [defaultId, setDefaultId] = useState(() => readDefaultView(page));
  const shareable = spec?.shared !== false;

  const list = views.data ?? [];
  const mine = list.filter((v) => v.mine);
  const shared = list.filter((v) => !v.mine && v.shared);
  const active = activeId ? list.find((v) => v.id === activeId) : undefined;
  const activePreset = activeId?.startsWith('preset:') ? presets.find((p) => presetId(p.name) === activeId) : undefined;
  const activeState = active ? viewStateOf(active) : activePreset?.state;
  const modified = Boolean(activeState && !sameState(activeState, current));
  const activeName = active?.name ?? activePreset?.name;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['views', page] });
  const failed = (title: string) => (e: unknown) =>
    toast({ tone: 'crit', title, description: e instanceof ApiRequestError ? `${e.message}${e.hint ? ` ${e.hint}` : ''}` : (e as Error).message });

  const save = useMutation({
    mutationFn: () => createView(page, { name: name.trim(), state: current as unknown as Record<string, unknown>, shared: shareable && share }),
    onSuccess: (v) => {
      void invalidate();
      setSaveOpen(false);
      toast({ tone: 'ok', title: `Saved view “${v.name}”`, description: v.shared ? 'Everyone with access to this page can use it.' : undefined });
      onApply(v.id, current);
    },
    onError: failed('The view wasn’t saved'),
  });
  const patch = useMutation({
    mutationFn: (body: Parameters<typeof updateView>[1]) => updateView(active!.id, body),
    onSuccess: (v, body) => {
      void invalidate();
      toast({
        tone: 'ok',
        title: body.state ? `Updated view “${v.name}”` : v.shared ? `“${v.name}” is now shared` : `“${v.name}” is private again`,
      });
    },
    onError: failed('The view wasn’t changed'),
  });
  const remove = useMutation({
    mutationFn: () => deleteView(active!.id),
    onSuccess: () => {
      const gone = active!;
      void invalidate();
      if (defaultId === gone.id) {
        writeDefaultView(page, undefined);
        setDefaultId(undefined);
      }
      toast({ tone: 'ok', title: `Deleted view “${gone.name}”` });
      onApply(undefined, { params: {}, table: {} });
    },
    onError: failed('The view wasn’t deleted'),
  });

  const setDefault = (id: string | undefined) => {
    writeDefaultView(page, id);
    setDefaultId(id);
    toast({ tone: 'ok', title: id ? `“${activeName}” opens by default on this page` : 'This page opens with its standard view' });
  };

  const item = (id: string, label: string, state: ViewState, hint?: string) => (
    <MenuItem
      key={id}
      icon={activeId === id ? <CheckIcon size={14} weight="bold" className="text-accent" /> : <span className="inline-block size-3.5" />}
      shortcut={defaultId === id ? <StarIcon size={12} weight="fill" aria-label="Default" /> : hint}
      onSelect={() => onApply(id, state)}
    >
      {label}
    </MenuItem>
  );

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button intent="secondary" aria-label={`Saved views: ${activeName ?? 'standard view'}${modified ? ', modified' : ''}`}>
            <BookmarkSimpleIcon size={16} aria-hidden className="text-fg-3" />
            <span className="max-w-44 truncate">{activeName ?? 'Views'}</span>
            {modified && <span className="text-xs font-normal text-fg-3">· modified</span>}
            <CaretDownIcon size={12} weight="bold" aria-hidden className="text-fg-3" />
          </Button>
        </MenuTrigger>
        <MenuContent className="max-h-(--radix-dropdown-menu-content-available-height) w-72 overflow-y-auto">
          <MenuLabel>Built-in</MenuLabel>
          {item('', 'Standard view', { params: {}, table: {} })}
          {presets.map((p) => item(presetId(p.name), p.name, p.state))}
          {views.isPending && <MenuItem disabled>Loading your views…</MenuItem>}
          {views.isError && <MenuItem disabled>Saved views are unavailable right now</MenuItem>}
          {mine.length > 0 && (
            <>
              <MenuSeparator />
              <MenuLabel>My views</MenuLabel>
              {mine.map((v) => item(v.id, v.name, viewStateOf(v), v.shared ? 'Shared' : undefined))}
            </>
          )}
          {shared.length > 0 && (
            <>
              <MenuSeparator />
              <MenuLabel>Shared by others</MenuLabel>
              {shared.map((v) => item(v.id, v.name, viewStateOf(v)))}
            </>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<FloppyDiskIcon size={15} />}
            onSelect={() => {
              setName(active && modified ? `${active.name} (copy)` : '');
              setShare(false);
              setSaveOpen(true);
            }}
          >
            Save as new view…
          </MenuItem>
          {active?.mine && modified && (
            <MenuItem icon={<FloppyDiskIcon size={15} />} onSelect={() => patch.mutate({ state: current as unknown as Record<string, unknown> })}>
              Update “{active.name}”
            </MenuItem>
          )}
          {active?.mine && shareable && (
            <MenuItem icon={<ShareNetworkIcon size={15} />} onSelect={() => patch.mutate({ shared: !active.shared })}>
              {active.shared ? 'Stop sharing' : 'Share with everyone'}
            </MenuItem>
          )}
          {activeId !== undefined && (activeId !== '' || defaultId) && (
            <MenuItem
              icon={<StarIcon size={15} />}
              onSelect={() => setDefault(defaultId === activeId || activeId === '' ? undefined : activeId)}
            >
              {defaultId === activeId || activeId === '' ? 'Use the standard view by default' : 'Open this view by default'}
            </MenuItem>
          )}
          {active?.mine && (
            <MenuItem icon={<TrashIcon size={15} />} tone="danger" onSelect={() => setDeleteOpen(true)}>
              Delete “{active.name}”…
            </MenuItem>
          )}
        </MenuContent>
      </Menu>

      <Dialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save view"
        description="Saves the current filters, columns, sort and density for this page."
        size="sm"
        footer={
          <>
            <Button intent="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button intent="primary" pending={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
              Save view
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <TextField label="Name" autoFocus maxLength={80} placeholder="e.g. Guests without sign-in" value={name} onChange={(e) => setName(e.target.value)} />
          {shareable && (
            <Switch
              label="Share with everyone"
              description="Others with access to this page can open it; only you can change it."
              checked={share}
              onCheckedChange={setShare}
            />
          )}
        </form>
      </Dialog>

      {active && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete view “${active.name}”?`}
          description={active.shared ? 'It’s shared, so it disappears for everyone who uses it.' : 'Only the view is deleted; no data changes.'}
          confirmLabel="Delete view"
          onConfirm={() => remove.mutateAsync().then(() => undefined)}
        />
      )}
    </>
  );
}
