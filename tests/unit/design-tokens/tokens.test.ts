import { contrastRatio, resolveHex, SEMANTIC_KEYS, THEME_NAMES, themes, type SemanticKey } from '@adminforge/design-tokens';

const SURFACES = ['canvas', 'panel', 'raised'] as const satisfies readonly SemanticKey[];
const TEXT_TARGETS: Array<[SemanticKey, number]> = [
  ['fg', 7], ['fg-2', 4.5], ['fg-3', 4.5], ['accent', 4.5], ['armed', 4.5], ['ok', 4.5], ['warn', 4.5], ['crit', 4.5],
];
const FILLS: Array<[SemanticKey, SemanticKey]> = [['on-armed', 'armed'], ['on-accent', 'accent'], ['fg-inverse', 'crit']];

describe.each(THEME_NAMES)('theme %s', (name) => {
  const hex = (key: SemanticKey) => resolveHex(themes[name][key]);

  it('defines every semantic key', () => {
    expect(Object.keys(themes[name]).sort()).toEqual([...SEMANTIC_KEYS].sort());
  });

  it.each(SURFACES)('text and status tokens meet contrast targets on %s', (surface) => {
    for (const [key, min] of TEXT_TARGETS) {
      const ratio = contrastRatio(hex(key), hex(surface));
      expect(ratio, `${key} on ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
    }
  });

  it.each(FILLS)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrastRatio(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('chart colors are at least 3:1 against panel', () => {
    for (const i of [1, 2, 3, 4, 5, 6] as const) {
      expect(contrastRatio(hex(`chart-${i}`), hex('panel'))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('resolveHex', () => {
  it('throws on unknown references', () => expect(() => resolveHex('{steel.123}')).toThrow(/Unknown color reference/));
});
