import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@adminforge/ui';
import { ResultsPanel, type RunState } from '@adminforge/web/src/query/ResultsPanel';
import { spreadsheetText, toCsv, toTsv } from '@adminforge/web/src/query/results';

// APP-05: "Copy" (tab-separated, for pasting into a spreadsheet) neutralises formulas like the CSV export does —
// a paste runs `=HYPERLINK(…)` from a sign-in user agent or an email subject just as an opened file would.
const COLUMNS = [
  { name: 'subject', type: 'string' },
  { name: 'delta', type: 'long' },
];
const HOSTILE = [
  '=HYPERLINK("http://evil.example","x")',
  '+cmd|calc',
  '-2+3',
  '@SUM(A1)',
  '\t=1+1',
  '\r=1+1',
];

describe('spreadsheetText', () => {
  it('prefixes formula starts with an apostrophe', () => {
    expect(HOSTILE.map(spreadsheetText)).toEqual(HOSTILE.map((s) => `'${s}`));
  });

  it('leaves plain text and negative numbers alone', () => {
    for (const s of ['hello', '-5', '-1.5', '-2e10', '42', 'a=b', '', ' =1'])
      expect(spreadsheetText(s)).toBe(s);
  });
});

describe('toTsv', () => {
  it('neutralises formulas in cells and headers, then flattens tabs and newlines', () => {
    const tsv = toTsv(
      [...COLUMNS, { name: '=header', type: 'string' }],
      [
        { subject: '=HYPERLINK("http://evil.example","x")', delta: -5, '=header': 'ok' },
        { subject: '\t=1+1', delta: 3, '=header': '@me\tthere' },
        { subject: 'line\none', delta: null, '=header': '' },
      ],
    );
    expect(tsv).toBe(
      [
        "subject\tdelta\t'=header",
        `'=HYPERLINK("http://evil.example","x")\t-5\tok`,
        "' =1+1\t3\t'@me there",
        'line one\t\t',
      ].join('\n'),
    );
  });

  it('copy and CSV follow the same rule', () => {
    const rows = HOSTILE.map((subject) => ({ subject, delta: 1 }));
    const tsvCells = toTsv(COLUMNS, rows)
      .split('\n')
      .slice(1)
      .map((l) => l.split('\t')[0] ?? '');
    const csvCells = toCsv(COLUMNS, rows)
      .split('\r\n')
      .slice(1, -1)
      .map((l) => l.replace(/^"|",1$|,1$/g, ''));
    for (const cell of [...tsvCells, ...csvCells]) expect(cell.startsWith("'")).toBe(true);
  });
});

describe('Query Studio Copy button', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts neutralised text on the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const state: RunState = {
      status: 'done',
      request: { source: 'logAnalytics', query: 'SigninLogs | take 2' },
      finishedAt: '2026-10-15T14:03:22Z',
      result: {
        columns: COLUMNS,
        rows: [
          { subject: '=HYPERLINK("http://evil.example","x")', delta: -5 },
          { subject: 'normal', delta: 2 },
        ],
        rowCount: 2,
        truncated: false,
        ms: 120,
        provenance: null,
      },
    };
    render(
      <ToastProvider>
        <ResultsPanel state={state} onRetry={() => {}} onCancel={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      `subject\tdelta\n'=HYPERLINK("http://evil.example","x")\t-5\nnormal\t2`,
    );
  });
});
