import { contrastRatio, resolveHex, themeMeta, themes, THEME_NAMES, type ThemeName } from '@adminforge/design-tokens';
import { api } from '../lib/api';
import { arr, num, parser, pick, rec } from '../runs/json';

/**
 * Runtime appearance overrides (§6.8 step 6), Portal.Admin:
 *   GET /api/admin/appearance → { version, overrides: { [theme]: { accent?, accent-strong?, focus?, radius-scale? } }, density?, fontScale? }
 *   PUT /api/admin/appearance { version (the one the edit started from; 409 if stale), overrides, density?, fontScale? }
 * Rollback re-publishes an earlier state taken from the audit log (`appearance.updated` events carry it).
 * Editable here: accent per theme, a radius scale (written to every theme), the default density, the base font size.
 * Other tokens already set through the API (accent-strong, focus) are kept as they are.
 */

export const MIN_CONTRAST = 4.5;
export const RADIUS_SCALES = [0.5, 0.75, 1, 1.25, 1.5] as const;
export const FONT_SCALES = [
  { value: 13 / 14, label: '13 px' },
  { value: 1, label: '14 px (default)' },
  { value: 15 / 14, label: '15 px' },
  { value: 16 / 14, label: '16 px' },
] as const;

export type Density = 'comfortable' | 'compact';
export type ThemeOverrides = Record<string, string | number>;

export interface AppearanceState {
  version: number;
  /** As stored, per theme (kept whole so tokens this page doesn't edit survive a publish). */
  overrides: Partial<Record<ThemeName, ThemeOverrides>>;
  density: Density | null;
  fontScale: number | null;
}

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: string) => HEX.test(v);

function readOverrides(v: unknown): AppearanceState['overrides'] {
  const out: AppearanceState['overrides'] = {};
  for (const t of THEME_NAMES) {
    const o = rec(rec(v)[t]);
    const kept: ThemeOverrides = {};
    for (const [k, x] of Object.entries(o)) if (typeof x === 'string' || typeof x === 'number') kept[k] = x;
    if (Object.keys(kept).length) out[t] = kept;
  }
  return out;
}

export const AppearanceResponse = parser((input): AppearanceState => {
  const o = rec(input);
  const version = num(o.version);
  if (version === undefined) throw new TypeError('Expected { version }');
  return {
    version,
    overrides: readOverrides(o.overrides),
    density: o.density === 'compact' || o.density === 'comfortable' ? o.density : null,
    fontScale: num(o.fontScale) ?? null,
  };
});

export const appearanceQuery = {
  queryKey: ['admin', 'appearance'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => api('/api/admin/appearance', { schema: AppearanceResponse, signal }),
};

export interface AppearanceBody {
  version: number;
  overrides: AppearanceState['overrides'];
  density?: Density;
  fontScale?: number;
}

export function putAppearance(body: AppearanceBody) {
  return api('/api/admin/appearance', { method: 'PUT', body, schema: AppearanceResponse });
}

/** Earlier published states, from the audit log (`appearance.updated` details). Needs audit access (Portal.Admin). */
export interface AppearanceVersion {
  seq: number;
  version: number | null;
  at: string;
  by: string | null;
  state: Omit<AppearanceBody, 'version'>;
}

export const appearanceHistoryQuery = {
  queryKey: ['admin', 'appearance', 'history'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api('/api/audit?action=appearance.updated&limit=20', {
      signal,
      schema: parser((input): AppearanceVersion[] =>
        arr(rec(input).items).flatMap((raw) => {
          const e = rec(raw);
          const d = rec(e.details);
          const seq = num(e.seq);
          const at = pick(e, 'ts');
          if (seq === undefined || !at || !d.overrides) return [];
          return [
            {
              seq,
              version: num(d.version) ?? null,
              at,
              by: pick(e, 'actorUpn') ?? null,
              state: {
                overrides: readOverrides(d.overrides),
                ...(d.density === 'compact' || d.density === 'comfortable' ? { density: d.density } : {}),
                ...(num(d.fontScale) !== undefined ? { fontScale: num(d.fontScale)! } : {}),
              },
            },
          ];
        }),
      ),
    }),
  retry: false,
};

/** The shipped value of a semantic token in a theme, as #RRGGBB. */
export const defaultHex = (theme: ThemeName, token: 'accent' | 'canvas' | 'panel' | 'raised' | 'on-accent') =>
  resolveHex(themes[theme][token]);

export interface ContrastCheck {
  against: string;
  ratio: number;
  ok: boolean;
}

/** Accent as text on every surface, and the on-accent label on an accent fill: all ≥ 4.5:1 (WCAG AA). */
export function accentChecks(theme: ThemeName, accent: string): ContrastCheck[] {
  if (!isHex(accent)) return [];
  const pairs: Array<[string, string]> = [
    ['canvas', defaultHex(theme, 'canvas')],
    ['panels', defaultHex(theme, 'panel')],
    ['menus', defaultHex(theme, 'raised')],
    ['button label', defaultHex(theme, 'on-accent')],
  ];
  return pairs.map(([against, bg]) => {
    const ratio = contrastRatio(accent, bg);
    return { against, ratio, ok: ratio >= MIN_CONTRAST };
  });
}

export const themeLabel = (t: ThemeName) => themeMeta[t].label;
export { THEME_NAMES, type ThemeName };

export interface Draft {
  accents: Record<ThemeName, string>;
  density: Density;
  fontScale: number;
  radiusScale: number;
}

export function draftFrom(s: Pick<AppearanceState, 'overrides' | 'density' | 'fontScale'>): Draft {
  const accent = (t: ThemeName) => {
    const v = s.overrides[t]?.accent;
    return typeof v === 'string' && isHex(v) ? v.toUpperCase() : defaultHex(t, 'accent');
  };
  const radius = THEME_NAMES.map((t) => s.overrides[t]?.['radius-scale']).find((v): v is number => typeof v === 'number');
  return {
    accents: Object.fromEntries(THEME_NAMES.map((t) => [t, accent(t)])) as Record<ThemeName, string>,
    density: s.density ?? 'comfortable',
    fontScale: s.fontScale ?? 1,
    radiusScale: radius ?? 1,
  };
}

/** The PUT body for a draft: only what differs from the shipped tokens; other stored tokens are kept. */
export function bodyFor(d: Draft, base: AppearanceState): AppearanceBody {
  const overrides: AppearanceBody['overrides'] = {};
  for (const t of THEME_NAMES) {
    const { accent: _a, 'radius-scale': _r, ...kept } = base.overrides[t] ?? {};
    const next: Record<string, string | number> = { ...kept };
    if (d.accents[t].toUpperCase() !== defaultHex(t, 'accent').toUpperCase()) next.accent = d.accents[t].toUpperCase();
    if (d.radiusScale !== 1) next['radius-scale'] = d.radiusScale;
    if (Object.keys(next).length) overrides[t] = next;
  }
  return {
    version: base.version,
    overrides,
    ...(d.density !== 'comfortable' ? { density: d.density } : {}),
    ...(Math.abs(d.fontScale - 1) > 0.001 ? { fontScale: Math.round(d.fontScale * 1000) / 1000 } : {}),
  };
}
