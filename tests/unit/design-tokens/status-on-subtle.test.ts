import { contrastRatio, resolveHex, THEME_NAMES, themes, type SemanticKey } from '@adminforge/design-tokens';

// Status pills and badges (ui/recipes/status-pill.ts, badge.ts) put a status colour on a `-subtle` fill (a colour at a
// few percent over the surface). The text must still reach 4.5:1 on the fill as the browser composites it, on every
// surface.

const SURFACES = ['canvas', 'panel', 'raised'] as const satisfies readonly SemanticKey[];
const PAIRS: Array<[SemanticKey, SemanticKey]> = [
  ['ok', 'ok-subtle'],
  ['warn', 'warn-subtle'],
  ['crit', 'crit-subtle'],
  ['accent', 'accent-subtle'],
  ['info', 'accent-subtle'],
];

/** `color-mix(in oklab, {ref} N%, transparent)` over an opaque surface: the colour at N% alpha, composited in sRGB. */
function composite(mix: string, surface: string): string {
  const m = /^color-mix\(in oklab, (\{[^}]+\}|#[0-9a-f]{6}) (\d+)%, transparent\)$/i.exec(mix);
  if (!m) throw new Error(`Unexpected subtle token ${mix}`);
  const fg = resolveHex(m[1]!);
  const a = Number(m[2]) / 100;
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(fg, i) * a + ch(surface, i) * (1 - a)));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

describe.each(THEME_NAMES)('theme %s: status text on its subtle fill', (name) => {
  const t = themes[name];
  it.each(SURFACES)('on %s', (surface) => {
    for (const [text, subtle] of PAIRS) {
      const fill = composite(t[subtle], resolveHex(t[surface]));
      const ratio = contrastRatio(resolveHex(t[text]), fill);
      expect(ratio, `${text} on ${subtle} over ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
