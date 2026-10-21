import { formatBytes } from '@adminforge/widgets';
import { committableFiles, readText } from '../../lib/repo';

// One byte formatter (organization review O-07): the `bytes` value format of every widget and the file sizes on the
// schedule and report pages' download links come from @adminforge/widgets. 1024-based; one decimal below 10 of a
// unit, none from 10 up.
describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1536, '1.5 KB'],
    [10 * 1024 - 1, '10.0 KB'],
    [47_002, '46 KB'],
    [61_440, '60 KB'],
    [1024 ** 2, '1.0 MB'],
    [5.25 * 1024 ** 2, '5.3 MB'],
    [12.3 * 1024 ** 2, '12 MB'],
    [1.5 * 1024 ** 3, '1.5 GB'],
    [2 * 1024 ** 4, '2.0 TB'],
    [-1536, '−1.5 KB'],
    [Number.NaN, '—'],
  ])('%d → %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });

  it('is defined once in runtime code', () => {
    const defines = committableFiles()
      .filter((f) => f.startsWith('portal/') && /\.(ts|tsx)$/.test(f))
      .filter((f) => /\b(function|const|let)\s+formatBytes\b/.test(readText(f) ?? ''));
    expect(defines).toEqual(['portal/packages/widgets/src/lib/format.ts']);
  });
});
