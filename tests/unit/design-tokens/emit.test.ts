import {
  emitCss,
  emitEchartsTheme,
  emitTailwindTheme,
  resolveRefs,
  SEMANTIC_KEYS,
} from '@adminforge/design-tokens';

describe('emitCss', () => {
  const css = emitCss();
  it('emits primitives, the default theme on :root, and later themes after it', () => {
    expect(css).toContain('--af-p-steel-900: #12171B;');
    expect(css).toMatch(/:root, \[data-theme="steel"\] \{[^}]*--af-canvas: var\(--af-p-steel-900\);/);
    expect(css.indexOf('[data-theme="daylight"]')).toBeGreaterThan(css.indexOf('[data-theme="steel"]'));
    expect(css).toMatch(/\[data-theme="daylight"\] \{\s*color-scheme: light;/);
  });
  it('emits densities and scale tokens', () => {
    expect(css).toMatch(/\[data-density="compact"\] \{[^}]*--af-row-h: 30px;/);
    expect(css).toContain('--af-font-size-md: 14px;');
    expect(css).toContain('--af-motion-slow: 320ms;');
  });
  it('re-resolves component tokens inside themed subtrees', () => {
    expect(css).toMatch(
      /:root, \[data-theme\], \[data-density\] \{[^}]*--af-table-row-h: var\(--af-row-h\);/,
    );
  });
});

describe('resolveRefs', () => {
  it('rejects unknown references', () =>
    expect(() => resolveRefs('{nope.1}')).toThrow(/Unknown color reference/));
});

describe('emitTailwindTheme', () => {
  const tw = emitTailwindTheme();
  it('removes Tailwind defaults and maps every semantic color', () => {
    expect(tw).toContain('--color-*: initial;');
    for (const k of SEMANTIC_KEYS) expect(tw).toContain(`--color-${k}: var(--af-${k});`);
    expect(tw).toContain('--text-2xs: var(--af-font-size-2xs);');
    expect(tw).toContain('--radius-lg: var(--af-radius-lg);');
  });
});

describe('emitEchartsTheme', () => {
  it('resolves chart colors to hex in fixed order', () => {
    expect(emitEchartsTheme('steel').color).toEqual([
      '#4A8AD8',
      '#C9692A',
      '#1F9C7E',
      '#9775E2',
      '#CB527F',
      '#AD8826',
    ]);
    expect(emitEchartsTheme('daylight').color[0]).toBe('#2A6CC0');
  });
});
