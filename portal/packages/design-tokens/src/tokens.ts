/**
 * AdminForge design tokens — the single source of truth for every visual attribute.
 *
 * Concept: cold steel while reading, hot iron when armed.
 *   steel   – neutral surfaces and text (dark default)
 *   mist    – neutral surfaces and text (light)
 *   temper  – accent: the oxide blue tempered steel takes
 *   ember   – write mode ("armed") ONLY; never in charts, status, or branding
 *   patina / straw / cinder – ok / warn / crit
 *
 * Tier 1 primitives → tier 2 semantic themes → tier 3 component tokens.
 * Theme values may reference primitives as {family.step}; they compile to var(--af-p-family-step).
 * Edit here, then `pnpm --filter @adminforge/design-tokens build` (pnpm dev watches).
 */

export const primitives = {
  color: {
    steel: {
      950: '#0D1114', 900: '#12171B', 850: '#161C21', 800: '#1B2228', 750: '#212930', 700: '#283139',
      600: '#343F49', 500: '#4A5763', 400: '#84919D', 300: '#AAB5BF', 100: '#DDE3E8',
    },
    mist: { 900: '#161C21', 700: '#3D4954', 600: '#57636E', 300: '#CBD3DA', 200: '#E2E6EA', 100: '#EEF1F3', 50: '#F7F8F9', 0: '#FFFFFF' },
    temper: { 800: '#234B86', 700: '#2E5FA8', 400: '#82A9EE', 300: '#A9C4F5' },
    ember: { 700: '#A8480B', 500: '#F47A2E' },
    patina: { 700: '#1E6E58', 400: '#5DC2A2' },
    straw: { 700: '#86650F', 400: '#E6C36A' },
    cinder: { 700: '#B03030', 400: '#F27474' },
    hc: {
      black: '#000000', 950: '#0A0A0A', 900: '#141414', line: '#5A5A5A', linestrong: '#8A8A8A', fg3: '#C8C8C8',
      fg2: '#E6E6E6', white: '#FFFFFF', accent: '#9CCBFF', armed: '#FFA261', ok: '#6EE7B7', warn: '#FFD966', crit: '#FF8A8A',
    },
    // Categorical chart palettes, validated with the dataviz palette validator
    // (dark vs #161C21, light vs #FFFFFF): lightness band, chroma, CVD ΔE, normal-vision ΔE, ≥3:1 contrast.
    'chart-dark': { 1: '#4A8AD8', 2: '#C9692A', 3: '#1F9C7E', 4: '#9775E2', 5: '#CB527F', 6: '#AD8826' },
    'chart-light': { 1: '#2A6CC0', 2: '#C25A14', 3: '#178366', 4: '#7A55D0', 5: '#C2416F', 6: '#9A7300' },
  },
} as const;

export const SEMANTIC_KEYS = [
  'canvas', 'panel', 'raised', 'sunken', 'hover', 'selected',
  'line', 'line-strong',
  'fg', 'fg-2', 'fg-3', 'fg-inverse',
  'accent', 'accent-strong', 'accent-subtle', 'on-accent',
  'armed', 'armed-subtle', 'on-armed',
  'ok', 'ok-subtle', 'warn', 'warn-subtle', 'crit', 'crit-subtle', 'info', 'neutral',
  'focus',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6',
] as const;
export type SemanticKey = (typeof SEMANTIC_KEYS)[number];

export const THEME_NAMES = ['steel', 'daylight', 'contrast'] as const; // default first
export type ThemeName = (typeof THEME_NAMES)[number];
export const DEFAULT_THEME: ThemeName = 'steel';

export const themeMeta: Record<ThemeName, { label: string; scheme: 'dark' | 'light' }> = {
  steel: { label: 'Steel', scheme: 'dark' },
  daylight: { label: 'Daylight', scheme: 'light' },
  contrast: { label: 'High contrast', scheme: 'dark' },
};

const mix = (ref: string, pct: number, over = 'transparent') => `color-mix(in oklab, ${ref} ${pct}%, ${over})`;
const charts = (family: 'chart-dark' | 'chart-light') =>
  Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`chart-${i}`, `{${family}.${i}}`])) as Record<`chart-${1 | 2 | 3 | 4 | 5 | 6}`, string>;

export const themes: Record<ThemeName, Record<SemanticKey, string>> = {
  steel: {
    canvas: '{steel.900}', panel: '{steel.850}', raised: '{steel.800}', sunken: '{steel.950}',
    hover: '{steel.750}', selected: mix('{temper.400}', 14, '{steel.850}'),
    line: '{steel.700}', 'line-strong': '{steel.600}',
    fg: '{steel.100}', 'fg-2': '{steel.300}', 'fg-3': '{steel.400}', 'fg-inverse': '{steel.950}',
    accent: '{temper.400}', 'accent-strong': '{temper.300}', 'accent-subtle': mix('{temper.400}', 16), 'on-accent': '{steel.950}',
    armed: '{ember.500}', 'armed-subtle': mix('{ember.500}', 16), 'on-armed': '{steel.950}',
    ok: '{patina.400}', 'ok-subtle': mix('{patina.400}', 14),
    warn: '{straw.400}', 'warn-subtle': mix('{straw.400}', 14),
    crit: '{cinder.400}', 'crit-subtle': mix('{cinder.400}', 14),
    info: '{temper.400}', neutral: '{steel.400}', focus: '{temper.300}',
    ...charts('chart-dark'),
  },
  daylight: {
    canvas: '{mist.100}', panel: '{mist.0}', raised: '{mist.50}', sunken: '{mist.200}',
    hover: '{mist.100}', selected: mix('{temper.700}', 10, '{mist.0}'),
    line: '{mist.200}', 'line-strong': '{mist.300}',
    fg: '{mist.900}', 'fg-2': '{mist.700}', 'fg-3': '{mist.600}', 'fg-inverse': '{mist.0}',
    accent: '{temper.700}', 'accent-strong': '{temper.800}', 'accent-subtle': mix('{temper.700}', 12), 'on-accent': '{mist.0}',
    armed: '{ember.700}', 'armed-subtle': mix('{ember.700}', 12), 'on-armed': '{mist.0}',
    ok: '{patina.700}', 'ok-subtle': mix('{patina.700}', 12),
    warn: '{straw.700}', 'warn-subtle': mix('{straw.700}', 12),
    crit: '{cinder.700}', 'crit-subtle': mix('{cinder.700}', 12),
    info: '{temper.700}', neutral: '{mist.600}', focus: '{temper.700}',
    ...charts('chart-light'),
  },
  contrast: {
    canvas: '{hc.black}', panel: '{hc.950}', raised: '{hc.900}', sunken: '{hc.black}',
    hover: '{hc.900}', selected: mix('{hc.accent}', 22, '{hc.black}'),
    line: '{hc.line}', 'line-strong': '{hc.linestrong}',
    fg: '{hc.white}', 'fg-2': '{hc.fg2}', 'fg-3': '{hc.fg3}', 'fg-inverse': '{hc.black}',
    accent: '{hc.accent}', 'accent-strong': '{hc.white}', 'accent-subtle': mix('{hc.accent}', 22), 'on-accent': '{hc.black}',
    armed: '{hc.armed}', 'armed-subtle': mix('{hc.armed}', 22), 'on-armed': '{hc.black}',
    ok: '{hc.ok}', 'ok-subtle': mix('{hc.ok}', 20),
    warn: '{hc.warn}', 'warn-subtle': mix('{hc.warn}', 20),
    crit: '{hc.crit}', 'crit-subtle': mix('{hc.crit}', 20),
    info: '{hc.accent}', neutral: '{hc.fg3}', focus: '{hc.white}',
    ...charts('chart-dark'),
  },
};

export const scale = {
  space: { 0: '0', 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px', 16: '64px' },
  radius: { none: '0', sm: '3px', md: '6px', lg: '10px', xl: '14px', pill: '999px' },
  fontSize: { '2xs': '11px', xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '20px', '2xl': '24px', '3xl': '32px', '4xl': '40px' },
  lineHeight: { tight: '1.15', snug: '1.3', normal: '1.5' },
  tracking: { label: '0.08em', tight: '-0.01em', normal: '0' },
  shadow: {
    1: '0 1px 0 rgb(0 0 0 / 0.25)',
    2: '0 6px 20px -6px rgb(0 0 0 / 0.45)',
    3: '0 18px 48px -12px rgb(0 0 0 / 0.55)',
  },
  motion: { fast: '120ms', base: '200ms', slow: '320ms', ease: 'cubic-bezier(0.2, 0, 0, 1)' },
  layout: { 'rail-h': '48px', 'nav-w': '240px', 'nav-w-collapsed': '56px', 'inspector-w': '460px', 'dock-h': '36px', 'content-max': '1680px' },
  z: { sticky: '10', dock: '20', drawer: '30', overlay: '40', toast: '50', palette: '60' },
} as const;

export const DENSITY_NAMES = ['comfortable', 'compact'] as const; // default first
export type DensityName = (typeof DENSITY_NAMES)[number];
export const DEFAULT_DENSITY: DensityName = 'comfortable';
export const densities: Record<DensityName, Record<string, string>> = {
  comfortable: { 'control-h': '34px', 'row-h': '40px', 'font-size-ui': '14px', 'pad-panel': '20px', 'gap-grid': '16px' },
  compact: { 'control-h': '28px', 'row-h': '30px', 'font-size-ui': '13px', 'pad-panel': '14px', 'gap-grid': '12px' },
};

export const fonts = {
  display: "'Archivo Variable', 'Archivo', ui-sans-serif, system-ui, sans-serif",
  body: "'Atkinson Hyperlegible Next Variable', 'Atkinson Hyperlegible Next', ui-sans-serif, system-ui, sans-serif",
  mono: "'Atkinson Hyperlegible Mono Variable', 'Atkinson Hyperlegible Mono', ui-monospace, 'Cascadia Mono', monospace",
} as const;

/** Tier 3: change one line and every instance follows. Values may use any --af-* variable. */
export const components = {
  'button-radius': 'var(--af-radius-md)',
  'input-radius': 'var(--af-radius-md)',
  'panel-radius': 'var(--af-radius-lg)',
  'panel-border': '1px solid var(--af-line)',
  'pill-radius': 'var(--af-radius-pill)',
  'table-row-h': 'var(--af-row-h)',
  'display-stretch': '112%',
  'brand-stretch': '118%',
  'label-stretch': '85%',
  'page-title-font': '650 var(--af-font-size-2xl) / var(--af-line-height-tight) var(--af-font-display)',
  'kpi-value-font': '600 var(--af-font-size-3xl) / 1 var(--af-font-display)',
  'label-font': '600 var(--af-font-size-2xs) / 1 var(--af-font-display)',
  'focus-ring': '0 0 0 2px var(--af-canvas), 0 0 0 4px var(--af-focus)',
  'armed-ring': 'inset 0 0 0 2px var(--af-armed)',
  'armed-texture': 'repeating-linear-gradient(45deg, rgb(0 0 0 / 0.08) 0 8px, transparent 8px 16px)',
} as const;

/** Resolves a theme value that is exactly one primitive reference (or a raw hex) to #RRGGBB. */
export function resolveHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  const m = /^\{([a-z-]+)\.([a-z0-9]+)\}$/i.exec(value);
  const hex = m ? (primitives.color as Record<string, Record<string, string>>)[m[1]!]?.[m[2]!] : undefined;
  if (!hex) throw new Error(`Unknown color reference ${value}`);
  return hex;
}
