import { contrastRatio, hexToRgb } from '@adminforge/design-tokens';

describe('color', () => {
  it('parses #RRGGBB', () => expect(hexToRgb('#82A9EE')).toEqual([130, 169, 238]));
  it('rejects other formats', () => expect(() => hexToRgb('red')).toThrow(/#RRGGBB/));
  it('computes WCAG 2 contrast', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#DDE3E8', '#12171B')).toBeCloseTo(13.94, 1);
  });
});
