import { useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { densities, scale } from '@adminforge/design-tokens';
import {
  ArrowCounterClockwiseIcon,
  Badge,
  Button,
  cn,
  ConfirmDialog,
  EmptyState,
  formatRelative,
  PageHeader,
  PaletteIcon,
  Panel,
  SegmentedControl,
  Select,
  Skeleton,
  STATUS_ICON,
  StatusPill,
  TextField,
  useNow,
  useToast,
} from '@adminforge/ui';
import { useMe } from '../lib/session';
import {
  accentChecks,
  appearanceQuery,
  defaultHex,
  FONT_SCALES,
  isHex,
  MIN_CONTRAST,
  putAppearance,
  RADIUS_SCALES,
  themeLabel,
  THEME_NAMES,
  appearanceHistoryQuery,
  bodyFor,
  draftFrom,
  type AppearanceBody,
  type Density,
  type Draft,
  type ThemeName,
} from './appearance';
import { loadAppearanceStylesheet } from './appearance-link';
import { Callout, isForbidden, QueryError, useDocumentTitle } from './ui';

const RADII = ['sm', 'md', 'lg', 'xl'] as const;

/** Inline token overrides for one preview card: the edited values, scoped to the card. */
function previewStyle(theme: ThemeName, d: Draft): CSSProperties {
  const accent = d.accents[theme];
  const vars: Record<string, string> = {};
  if (isHex(accent)) {
    vars['--af-accent'] = accent;
    vars['--af-info'] = accent;
    vars['--af-accent-strong'] = `color-mix(in oklab, ${accent} 80%, var(--af-fg))`;
    vars['--af-accent-subtle'] = `color-mix(in oklab, ${accent} 16%, transparent)`;
    vars['--af-focus'] = accent;
  }
  for (const r of RADII) vars[`--af-radius-${r}`] = `calc(${scale.radius[r]} * ${d.radiusScale})`;
  for (const f of ['2xs', 'xs', 'sm', 'md', 'lg', 'xl'] as const) vars[`--af-font-size-${f}`] = `calc(${scale.fontSize[f]} * ${d.fontScale})`;
  vars['--af-font-size-ui'] = `calc(${densities[d.density]['font-size-ui']} * ${d.fontScale})`;
  return vars as CSSProperties;
}

function PreviewCard({ theme, draft }: { theme: ThemeName; draft: Draft }) {
  const checks = accentChecks(theme, draft.accents[theme]);
  const failing = checks.some((c) => !c.ok);
  return (
    <figure
      data-theme={theme}
      data-density={draft.density}
      style={previewStyle(theme, draft)}
      className="m-0 flex flex-col gap-3 rounded-(--af-panel-radius) border border-line bg-canvas p-4 text-fg"
      aria-label={`${themeLabel(theme)} preview`}
    >
      <figcaption className="af-eyebrow flex items-center justify-between">
        {themeLabel(theme)}
        {failing && <span className="font-body text-xs tracking-normal text-crit normal-case">Fails contrast</span>}
      </figcaption>
      <div className="flex flex-col gap-3 rounded-(--af-panel-radius) border border-line bg-panel p-3" style={{ fontSize: 'var(--af-font-size-ui)' }}>
        <p className="font-semibold">Disable sign-in</p>
        <p className="text-sm text-fg-2">
          Blocks sign-in for <span className="font-medium text-accent">a.lee@example.com</span> and revokes sessions.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-(--af-control-h) items-center rounded-(--af-button-radius) bg-accent px-3 font-semibold text-on-accent">Preview</span>
          <span className="inline-flex h-(--af-control-h) items-center rounded-(--af-button-radius) border border-line bg-raised px-3 font-semibold">Cancel</span>
          <StatusPill status="info" size="sm">
            Planned
          </StatusPill>
        </div>
        <span className="flex h-(--af-control-h) items-center rounded-(--af-input-radius) border border-accent bg-sunken px-2.5 text-sm text-fg-3 outline-1 outline-accent">
          Focused input
        </span>
      </div>
    </figure>
  );
}

function AccentRow({ theme, value, onChange }: { theme: ThemeName; value: string; onChange: (v: string) => void }) {
  // While typing, the field shows what was typed; otherwise it follows the colour picker.
  const [typing, setTyping] = useState<string | null>(null);
  const text = typing ?? value;
  const def = defaultHex(theme, 'accent');
  const checks = accentChecks(theme, value);
  const valid = isHex(text);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
          {themeLabel(theme)}
          <input
            type="color"
            value={isHex(value) ? value.toLowerCase() : def.toLowerCase()}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            aria-label={`${themeLabel(theme)} accent colour picker`}
            className="h-(--af-control-h) w-14 cursor-pointer rounded-(--af-input-radius) border border-line bg-sunken p-1"
          />
        </label>
        <TextField
          label="Hex"
          hideLabel
          aria-label={`${themeLabel(theme)} accent hex value`}
          value={text}
          spellCheck={false}
          inputClassName="w-28 font-mono uppercase"
          error={valid ? undefined : 'Use #RRGGBB.'}
          onChange={(e) => {
            const v = `#${e.target.value.replace(/^#+/, '').slice(0, 6)}`;
            setTyping(v);
            if (isHex(v)) onChange(v.toUpperCase());
          }}
          onBlur={() => isHex(text) && setTyping(null)}
        />
        {value.toUpperCase() !== def.toUpperCase() && (
          <Button size="sm" intent="ghost" onClick={() => onChange(def)}>
            Reset to {def}
          </Button>
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={`${themeLabel(theme)} contrast checks`}>
        {checks.map((c) => {
          const Glyph = STATUS_ICON[c.ok ? 'ok' : 'crit'];
          return (
            <li key={c.against} className={cn('inline-flex items-center gap-1', c.ok ? 'text-fg-2' : 'font-semibold text-crit')}>
              <Glyph size={12} weight="fill" aria-hidden className={c.ok ? 'text-ok' : 'text-crit'} />
              {c.ratio.toFixed(2)}:1 {c.against === 'button label' ? 'for button labels' : `on ${c.against}`}
              <span className="sr-only">{c.ok ? '(passes)' : `(fails, needs ${MIN_CONTRAST}:1)`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Appearance (§6.8, Portal.Admin): allowlisted runtime tokens with live preview, a contrast gate, publish and rollback. */
export function AppearancePage() {
  const me = useMe();
  const now = useNow(60_000);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  useDocumentTitle('Appearance');
  const q = useQuery({ ...appearanceQuery, retry: false });
  const published = useMemo(() => (q.data ? draftFrom(q.data) : null), [q.data]);
  // Edits on top of the published state; null = nothing changed (also after publish or discard).
  const [edits, setEdits] = useState<Draft | null>(null);
  const draft = edits ?? published;
  const setDraft = (update: (d: Draft | null) => Draft | null | undefined) => setEdits((e) => update(e ?? published) ?? null);
  const dirty = Boolean(draft && published && JSON.stringify(draft) !== JSON.stringify(published));
  const failures = draft
    ? THEME_NAMES.flatMap((t) => accentChecks(t, draft.accents[t]).filter((c) => !c.ok).map((c) => ({ theme: t, ...c })))
    : [];
  const invalid = draft ? THEME_NAMES.some((t) => !isHex(draft.accents[t])) : false;

  const history = useQuery(appearanceHistoryQuery);
  const save = useMutation({
    mutationFn: ({ body }: { body: AppearanceBody; label: string }) => putAppearance(body),
    onSuccess: (next, { label }) => {
      queryClient.setQueryData(appearanceQuery.queryKey, next);
      void queryClient.invalidateQueries({ queryKey: appearanceHistoryQuery.queryKey });
      setEdits(null);
      loadAppearanceStylesheet(next.version);
      toast({
        tone: 'ok',
        title: `${label} (version ${next.version})`,
        description: 'Everyone sees it on their next page load. The change is in the audit log.',
      });
    },
    onError: (e) => toast({ tone: 'crit', title: 'Appearance wasn’t saved', description: (e as Error).message }),
  });

  const publish = () => {
    if (!draft || !q.data || failures.length || invalid || !dirty) return;
    save.mutate({ body: bodyFor(draft, q.data), label: 'Appearance published' });
  };

  if (q.isError && isForbidden(q.error))
    return (
      <>
        <PageHeader eyebrow="Admin" title="Appearance" />
        <Panel>
          <EmptyState title="Appearance is managed by Portal Admins" icon={<PaletteIcon size={20} />}>
            {me.user.upn} doesn’t have the Portal Admin role. Your own theme and density are in the user menu.
          </EmptyState>
        </Panel>
      </>
    );

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Appearance"
        description="Adjust the few tokens AdminForge allows at runtime. Every change is contrast-checked, previewed in all three themes, published for everyone, and audited."
        meta={q.data && <Badge mono>Published version {q.data.version}</Badge>}
        actions={
          <>
            <Button intent="ghost" onClick={() => setEdits(null)} aria-disabled={!dirty || undefined}>
              Discard changes
            </Button>
            <Button intent="primary" pending={save.isPending} aria-disabled={!dirty || failures.length > 0 || invalid || undefined} onClick={publish}>
              Publish
            </Button>
          </>
        }
      />
      {q.isError ? (
        <Panel>
          <QueryError title="Appearance settings didn’t load" error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      ) : !draft || !q.data ? (
        <div className="grid gap-6 xl:grid-cols-2" aria-busy="true">
          <Skeleton shape="block" className="h-96" />
          <Skeleton shape="block" className="h-96" />
        </div>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-5">
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-3">
            {failures.length > 0 && (
              <Callout tone="crit" role="alert" title="This can’t be published: some text would be hard to read">
                <ul className="flex list-disc flex-col gap-0.5 pl-4">
                  {failures.map((f) => (
                    <li key={`${f.theme}-${f.against}`}>
                      {themeLabel(f.theme)} accent is {f.ratio.toFixed(2)}:1 {f.against === 'button label' ? 'against its button label' : `on ${f.against}`} —
                      it needs at least {MIN_CONTRAST}:1.
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
            {dirty && failures.length === 0 && !invalid && (
              <Callout tone="info" title="Unpublished changes">
                The previews show your draft. Publish to apply it for everyone.
              </Callout>
            )}
            <Panel eyebrow="Colour" title="Accent per theme" description="Links, focus rings, selection and primary buttons. Ember (write mode) and status colours are fixed.">
              <div className="flex flex-col gap-4">
                {THEME_NAMES.map((t) => (
                  <AccentRow key={t} theme={t} value={draft.accents[t]} onChange={(v) => setDraft((d) => d && { ...d, accents: { ...d.accents, [t]: v } })} />
                ))}
              </div>
            </Panel>
            <Panel eyebrow="Shape and type" title="Corners, density and text size">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-fg" id="radius-label">
                    Corner radius
                  </span>
                  <SegmentedControl
                    aria-label="Corner radius"
                    value={String(draft.radiusScale)}
                    onValueChange={(v) => setDraft((d) => d && { ...d, radiusScale: Number(v) })}
                    options={RADIUS_SCALES.map((r) => ({ value: String(r), label: r === 1 ? 'Default' : `${Math.round(r * 100)}%` }))}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-fg">Default density</span>
                  <SegmentedControl
                    aria-label="Default density"
                    value={draft.density}
                    onValueChange={(v) => setDraft((d) => d && { ...d, density: v as Density })}
                    options={[
                      { value: 'comfortable', label: 'Comfortable' },
                      { value: 'compact', label: 'Compact' },
                    ]}
                  />
                  <span className="text-xs text-fg-3">People who picked their own density keep it.</span>
                </div>
                <Select
                  label="Base font size"
                  value={String(FONT_SCALES.find((f) => Math.abs(f.value - draft.fontScale) < 0.001)?.value ?? 1)}
                  onValueChange={(v) => setDraft((d) => d && { ...d, fontScale: Number(v) })}
                  options={FONT_SCALES.map((f) => ({ value: String(f.value), label: f.label }))}
                  className="max-w-56"
                />
              </div>
            </Panel>
            <Panel eyebrow="History" title="Roll back">
              <div className="flex flex-col gap-3 text-sm">
                {history.isError ? (
                  <p className="text-fg-3">Earlier versions come from the audit log, which didn’t load.</p>
                ) : history.isPending ? (
                  <Skeleton className="h-16 w-full" shape="block" />
                ) : history.data.length === 0 ? (
                  <p className="text-fg-3">No earlier versions yet.</p>
                ) : (
                  <ul className="flex flex-col">
                    {history.data.slice(0, 6).map((h) => {
                      const current = h.version === q.data!.version;
                      return (
                        <li key={h.seq} className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
                          <span className="min-w-0 truncate text-fg-2">
                            <span className="font-mono text-xs text-fg">v{h.version ?? '?'}</span>
                            {h.by && ` · ${h.by}`} · {formatRelative(h.at, now)}
                          </span>
                          {current ? (
                            <Badge tone="accent">Current</Badge>
                          ) : (
                            <ConfirmDialog
                              trigger={
                                <Button size="sm" intent="ghost">
                                  <ArrowCounterClockwiseIcon size={13} aria-hidden />
                                  Roll back
                                </Button>
                              }
                              title={`Roll back to version ${h.version ?? '?'}?`}
                              description="That version’s overrides are published again as a new version. Everyone gets them on their next page load; the rollback is audited."
                              confirmLabel="Roll back"
                              intent="primary"
                              onConfirm={() =>
                                save
                                  .mutateAsync({ body: { version: q.data!.version, ...h.state }, label: `Rolled back to version ${h.version ?? '?'}` })
                                  .then(() => undefined)
                              }
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div>
                  <ConfirmDialog
                    trigger={<Button size="sm">Reset everything to the shipped defaults</Button>}
                    title="Reset appearance to the defaults?"
                    description="Removes every runtime override (accents, corners, density, font size) and publishes that as a new version."
                    confirmLabel="Reset and publish"
                    intent="primary"
                    onConfirm={() =>
                      save.mutateAsync({ body: { version: q.data!.version, overrides: {} }, label: 'Appearance reset to defaults' }).then(() => undefined)
                    }
                  />
                </div>
              </div>
            </Panel>
          </div>
          <section aria-label="Live preview" className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-(--af-layout-rail-h) xl:col-span-2 xl:pt-1">
            <h2 className="af-eyebrow">Live preview</h2>
            {THEME_NAMES.map((t) => (
              <PreviewCard key={t} theme={t} draft={draft} />
            ))}
          </section>
        </div>
      )}
    </>
  );
}
