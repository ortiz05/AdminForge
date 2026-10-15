import {
  __resetHistoryForTests,
  clearHistory,
  HISTORY_KEY,
  HISTORY_MAX,
  readHistory,
  recordRun,
} from '@adminforge/web/src/query/history';
import { completionWords, kqlMonarch } from '@adminforge/web/src/query/kql-language';
import { QueryResultParser } from '@adminforge/web/src/query/contracts';
import { GALLERY } from '@adminforge/web/src/query/gallery';
import {
  categoryLabel,
  chartData,
  csvFileName,
  defaultChartConfig,
  shortenTimes,
  toCsv,
  toTsv,
  valueKind,
} from '@adminforge/web/src/query/results';
import { SOURCE_META } from '@adminforge/web/src/query/sources';
import { slugOf } from '@adminforge/web/src/query/SaveDialog';
import { MIN_TEXT_CONTRAST, monacoTheme } from '@adminforge/web/src/query/monaco-theme';
import { contrastRatio, THEME_NAMES } from '@adminforge/design-tokens';

describe('query results helpers', () => {
  it('maps KQL column types to how they are shown', () => {
    expect(['int', 'long', 'real', 'decimal'].map(valueKind)).toEqual([
      'number',
      'number',
      'number',
      'number',
    ]);
    expect(
      ['datetime', 'bool', 'guid', 'dynamic', 'timespan', 'string', 'SomethingNew'].map(valueKind),
    ).toEqual(['datetime', 'bool', 'guid', 'dynamic', 'timespan', 'text', 'text']);
  });

  it('CSV quotes, escapes, and neutralises spreadsheet formulas but keeps negative numbers', () => {
    const csv = toCsv(
      [
        { name: 'name', type: 'string' },
        { name: 'delta', type: 'long' },
        { name: 'tags', type: 'dynamic' },
      ],
      [
        {
          name: '=HYPERLINK("http://evil.example")',
          delta: -5,
          tags: { owner: 'ops', 'cost,center': 'a"b' },
        },
        { name: 'line\nbreak', delta: null, tags: null },
        { name: '@SUM(A1)', delta: 3, tags: ['x'] },
      ],
    );
    expect(csv).toBe(
      [
        'name,delta,tags',
        `"'=HYPERLINK(""http://evil.example"")",-5,"{""owner"":""ops"",""cost,center"":""a\\""b""}"`,
        '"line\nbreak",,',
        `'@SUM(A1),3,"[""x""]"`,
        '',
      ].join('\r\n'),
    );
  });

  it('TSV flattens tabs and newlines inside cells', () => {
    expect(
      toTsv(
        [
          { name: 'a', type: 'string' },
          { name: 'b', type: 'string' },
        ],
        [{ a: 'x\ty', b: 'one\ntwo' }],
      ),
    ).toBe('a\tb\nx y\tone two');
  });

  it('names exports by source and UTC time', () => {
    expect(csvFileName('resourceGraph', new Date('2026-10-15T14:03:22.123Z'))).toBe(
      'query-resourcegraph-2026-10-15T14-03-22Z.csv',
    );
  });

  it('pivots rows into chart series: sums duplicates, sorts time, folds the smallest series into Other', () => {
    const columns = [
      { name: 't', type: 'datetime' },
      { name: 'who', type: 'string' },
      { name: 'n', type: 'long' },
    ];
    const who = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = [
      ...who.map((w, i) => ({ t: '2026-10-15T02:00:00Z', who: w, n: 10 - i })),
      ...who.map((w, i) => ({ t: '2026-10-15T01:00:00Z', who: w, n: 10 - i })),
      { t: '2026-10-15T01:00:00Z', who: 'a', n: 5 },
    ];
    const data = chartData(columns, rows, { x: 't', y: 'n', split: 'who', kind: 'line' }, 6);
    expect(data.categories).toEqual(['01:00', '02:00']); // one day: the date is dropped
    expect(data.series.map((s) => s.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'Other (3)']);
    expect(data.series[0]!.data).toEqual([15, 10]);
    expect(data.series[5]!.data).toEqual([5 + 4 + 3, 5 + 4 + 3]); // f + g + h
    expect(data.foldedSeries).toBe(3);
  });

  it('chooses default axes: time or text on x, the first number on y', () => {
    expect(
      defaultChartConfig([
        { name: 'type', type: 'string' },
        { name: 'count_', type: 'long' },
      ]),
    ).toEqual({ x: 'type', y: 'count_', kind: 'bar' });
    expect(
      defaultChartConfig([
        { name: 'TimeGenerated', type: 'datetime' },
        { name: 'Caller', type: 'string' },
        { name: 'changes', type: 'long' },
      ]),
    ).toEqual({ x: 'TimeGenerated', y: 'changes', split: 'Caller', kind: 'line' });
    expect(defaultChartConfig([{ name: 'name', type: 'string' }])).toBeNull();
    expect(categoryLabel('2026-10-15T00:00:00Z', 'datetime')).toBe('2026-10-15');
    expect(categoryLabel(null, 'text')).toBe('(empty)');
    expect(shortenTimes(['2026-10-14 23:00', '2026-10-15 01:00'], 'datetime')).toEqual([
      '10-14 23:00',
      '10-15 01:00',
    ]);
    expect(shortenTimes(['2025-12-31 23:00', '2026-01-01 01:00'], 'datetime')).toEqual([
      '2025-12-31 23:00',
      '2026-01-01 01:00',
    ]);
    expect(shortenTimes(['2026-10-14', '2026-10-15'], 'datetime')).toEqual(['2026-10-14', '2026-10-15']);
  });

  it('reads both row shapes from /api/query (objects, or arrays aligned with columns)', () => {
    const r = QueryResultParser.parse({
      columns: [{ name: 'a', type: 'Long' }, { name: 'b' }],
      rows: [[1, 'x'], { a: 2, b: 'y' }],
      ms: 5,
      truncated: false,
    });
    expect(r.columns).toEqual([
      { name: 'a', type: 'long' },
      { name: 'b', type: 'string' },
    ]);
    expect(r.rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
    expect(r.rowCount).toBe(2);
    expect(r.provenance).toBeNull();
    expect(() => QueryResultParser.parse({ rows: [] })).toThrow();
  });

  it('derives the branch name from the scaffold path', () => {
    expect(slugOf('portal/content/reports/azure/untagged.report.yaml')).toBe('untagged');
    expect(slugOf('portal/content/probes/storage-public.probe.yaml')).toBe('storage-public');
  });
});

describe('query history', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetHistoryForTests();
  });

  it('keeps the newest first, de-duplicates the same query, caps the list, and ignores corrupt storage', () => {
    for (let i = 0; i < HISTORY_MAX + 5; i++)
      recordRun({
        source: 'resourceGraph',
        query: `resources | take ${i}`,
        ranAt: new Date(2026, 9, 15, 0, i).toISOString(),
      });
    recordRun({
      source: 'resourceGraph',
      query: 'resources | take 3',
      ranAt: '2026-10-16T00:00:00.000Z',
      rowCount: 3,
    });
    __resetHistoryForTests();
    const h = readHistory();
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0]).toMatchObject({ query: 'resources | take 3', rowCount: 3 });
    expect(h.filter((e) => e.query === 'resources | take 3')).toHaveLength(1);

    localStorage.setItem(HISTORY_KEY, '{not json');
    expect(readHistory()).toEqual([]);
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([
        { source: 'nope', query: 'x', ranAt: 'y' },
        { source: 'logAnalytics', query: 'Usage', ranAt: 'z', subscriptions: [1, 'a'] },
      ]),
    );
    expect(readHistory()).toEqual([
      { source: 'logAnalytics', query: 'Usage', ranAt: 'z', subscriptions: ['a'] },
    ]);
    clearHistory();
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull();
  });
});

describe('KQL editor language', () => {
  it('offers the current source’s tables first, then result columns, operators and functions', () => {
    const words = completionWords(SOURCE_META.logAnalytics.tables, ['Caller']);
    expect(words[0]).toEqual({ label: 'AzureActivity', kind: 'table' });
    expect(words.find((w) => w.label === 'Caller')).toEqual({ label: 'Caller', kind: 'column' });
    expect(words.find((w) => w.label === 'mv-expand')?.kind).toBe('keyword');
    expect(words.find((w) => w.label === 'arg_max')?.kind).toBe('function');
    expect(new Set(words.map((w) => w.label)).size).toBe(words.length);
  });

  it.each(THEME_NAMES)(
    'derives the editor theme from tokens, every syntax colour at AA on the editor background · %s',
    (theme) => {
      const t = monacoTheme(theme);
      const bg = t.colors['editor.background']!;
      expect(bg).toMatch(/^#[0-9A-F]{6}$/);
      for (const rule of t.rules)
        expect(contrastRatio(`#${rule.foreground}`, bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      // Keywords and strings stay distinguishable from plain text.
      const fg = t.rules.find((r) => r.token === '')!.foreground;
      expect(t.rules.find((r) => r.token === 'keyword')!.foreground).not.toBe(fg);
      expect(t.rules.find((r) => r.token === 'string')!.foreground).not.toBe(fg);
    },
  );

  it('builds a Monarch tokenizer that knows the tables', () => {
    const lang = kqlMonarch(['resources']) as unknown as { tables: string[]; tokenizer: { root: unknown[] } };
    expect(lang.tables).toEqual(['resources']);
    expect(lang.tokenizer.root.length).toBeGreaterThan(10);
  });

  it('every starter query is bounded and uses a table the editor knows', () => {
    for (const q of GALLERY) {
      const first = q.query.trim().split(/\s|\|/)[0]!;
      if (first !== 'print') expect(SOURCE_META[q.source].tables).toContain(first);
      expect(q.query).toMatch(/\b(summarize|top|take|project|print)\b/);
    }
    expect(new Set(GALLERY.map((q) => q.id)).size).toBe(GALLERY.length);
    for (const s of ['resourceGraph', 'logAnalytics', 'advancedHunting'] as const)
      expect(GALLERY.filter((q) => q.source === s).length).toBeGreaterThanOrEqual(6);
  });
});
