import { z } from 'zod';
// @adminforge/design-tokens is not (yet) an api dependency; it is dependency-free TypeScript, so import it by path.
import { contrastRatio, DEFAULT_THEME, densities, DENSITY_NAMES, resolveHex, scale, THEME_NAMES, themes, type ThemeName } from '@adminforge/design-tokens';
import { AppError } from '../errors';

export const APPEARANCE_KEY = 'appearance';
/** Tokens an admin may override at runtime (ADR-007 central control): accent, accent-strong, focus, radius scale. */
export const COLOR_TOKENS = ['accent', 'accent-strong', 'focus'] as const;
export const MIN_CONTRAST = 4.5;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a colour like #2E5FA8');
const ThemeOverrides = z.strictObject({
  accent: Hex.optional(),
  'accent-strong': Hex.optional(),
  focus: Hex.optional(),
  /** Multiplies the radius scale (sm, md, lg, xl); 0 = square corners. */
  'radius-scale': z.number().min(0).max(2).optional(),
});

export const Appearance = z.strictObject({
  overrides: z.partialRecord(z.enum(THEME_NAMES), ThemeOverrides).default({}),
  /** Default density for users without a preference. */
  density: z.enum(DENSITY_NAMES).optional(),
  /** Multiplies every font size (0.85–1.25). */
  fontScale: z.number().min(0.85).max(1.25).optional(),
});
export type Appearance = z.infer<typeof Appearance>;

/** PUT body: the full appearance plus the version it was based on (409 when someone else saved in between). */
export const AppearanceUpdate = Appearance.extend({ version: z.number().int().min(0).optional() });

/** Every override colour needs ≥ 4.5:1 against the theme's canvas and panel. Returns problems (empty = fine). */
export function contrastProblems(a: Appearance): string[] {
  const out: string[] = [];
  for (const [theme, tokens] of Object.entries(a.overrides) as Array<[ThemeName, z.infer<typeof ThemeOverrides>]>) {
    const surfaces = { canvas: resolveHex(themes[theme].canvas), panel: resolveHex(themes[theme].panel) };
    for (const token of COLOR_TOKENS) {
      const value = tokens?.[token];
      if (!value) continue;
      for (const [name, bg] of Object.entries(surfaces)) {
        const ratio = contrastRatio(value, bg);
        if (ratio < MIN_CONTRAST) out.push(`${theme}.${token} ${value} has ${ratio.toFixed(2)}:1 against ${name} ${bg}; it needs at least ${MIN_CONTRAST}:1.`);
      }
    }
  }
  return out;
}

export function validateAppearance(body: unknown): z.infer<typeof AppearanceUpdate> {
  const parsed = AppearanceUpdate.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'invalid_appearance', `Appearance is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
  }
  const problems = contrastProblems(parsed.data);
  if (problems.length) throw new AppError(400, 'contrast', problems.join(' '), { hint: 'Pick a colour with more contrast (WCAG AA, 4.5:1).' });
  return parsed.data;
}

const themeSelector = (t: ThemeName) => (t === DEFAULT_THEME ? `:root:not([data-theme]), [data-theme="${t}"]` : `[data-theme="${t}"]`);
const RADII = ['sm', 'md', 'lg', 'xl'] as const;

/** GET /api/appearance.css — the overrides as CSS custom properties, loaded after tokens.css. */
export function appearanceCss(a: Appearance, version: number): string {
  const blocks: string[] = [`/* AdminForge appearance v${version} (runtime overrides; edit in Admin → Appearance) */`];
  const root: string[] = [];
  if (a.fontScale && a.fontScale !== 1) for (const [k, v] of Object.entries(scale.fontSize)) root.push(`--af-font-size-${k}: calc(${v} * ${a.fontScale});`);
  if (root.length) blocks.push(`:root {\n${root.map((l) => `  ${l}`).join('\n')}\n}`);
  if (a.density) blocks.push(`:root:not([data-density]) {\n${Object.entries(densities[a.density]).map(([k, v]) => `  --af-${k}: ${v};`).join('\n')}\n}`);
  for (const theme of THEME_NAMES) {
    const t = a.overrides[theme];
    if (!t) continue;
    const lines: string[] = [];
    for (const token of COLOR_TOKENS) if (t[token]) lines.push(`--af-${token}: ${t[token]!.toUpperCase()};`);
    if (t['radius-scale'] !== undefined) for (const r of RADII) lines.push(`--af-radius-${r}: calc(${scale.radius[r]} * ${t['radius-scale']});`);
    if (lines.length) blocks.push(`${themeSelector(theme)} {\n${lines.map((l) => `  ${l}`).join('\n')}\n}`);
  }
  return `${blocks.join('\n\n')}\n`;
}
