import { committableFiles, readText } from '../lib/repo';

// A ceiling on runtime file size (organization review O-04): no runtime file under portal/ grows past MAX_LINES. The
// files already over it are listed at their line count when the ratchet was set: they may shrink, never grow. Split
// one when a feature touches it (docs/backlog.md); outbound.ts only with the security reviewer.
//
// The list stays honest: a listed file that grows fails; so does one that shrank by more than SLACK lines (lower its
// entry to the new count), fell to the ceiling or below (remove the entry), or no longer exists.
const MAX_LINES = 800;
const SLACK = 50;

const OVER_CEILING: Record<string, number> = {
  // +533 for resume re-checks (built alongside this guard); the re-check machinery is the first piece to move out.
  'portal/packages/engine/src/engine.ts': 2401,
  'portal/apps/api/src/execution/outbound.ts': 1724,
  'portal/apps/api/src/runs/service.ts': 1505,
  'portal/packages/ui/src/primitives/DataTable.tsx': 1344,
  'portal/apps/api/src/datasources/executor.ts': 1205,
  'portal/packages/expressions/src/helpers.ts': 1164,
  'portal/apps/api/src/probes/checks.ts': 1147,
  'portal/apps/api/src/schedules/scheduler.ts': 1121,
  'portal/apps/web/src/pages/design/sections.tsx': 1009,
  'portal/packages/expressions/src/taint.ts': 969,
  'portal/apps/api/src/schedules/service.ts': 821,
};

/** Runtime code: TypeScript/JavaScript, PowerShell and shell under portal/ — not generated files. */
const RUNTIME = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|ps1|psm1|sh)$/;
const GENERATED = /(^|\/)(routeTree\.gen\.ts|generated\/)/;

const files = committableFiles().filter(
  (f) =>
    f.startsWith('portal/') &&
    RUNTIME.test(f) &&
    !GENERATED.test(f) &&
    !f.includes('/node_modules/') &&
    !f.includes('/dist/'),
);

/** Lines as `wc -l` counts them for a file that ends with a newline. */
function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** What is wrong with one file's size against the ceiling and its entry; null when nothing is. */
function sizeProblem(file: string, lines: number | undefined, entry: number | undefined): string | null {
  if (entry === undefined) {
    if (lines === undefined || lines <= MAX_LINES) return null;
    return `${file}: ${lines} lines, over the ${MAX_LINES}-line ceiling — split it (move a part into its own module)`;
  }
  if (lines === undefined) return `${file}: listed in OVER_CEILING but gone — remove its entry`;
  if (lines > entry)
    return `${file}: grew to ${lines} lines (listed at ${entry}) — split it, or move as much out as you add`;
  if (lines <= MAX_LINES) return `${file}: ${lines} lines, within the ceiling now — remove its entry`;
  if (entry - lines > SLACK)
    return `${file}: shrank to ${lines} lines — lower its entry from ${entry} to ${lines}`;
  return null;
}

describe('runtime files stay under the size ceiling', () => {
  const sizes = new Map(files.map((f) => [f, lineCount(readText(f) ?? '')]));

  it('reads the runtime files', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('.ps1'))).toBe(true);
    expect(files.some((f) => GENERATED.test(f))).toBe(false);
  });

  it(`no runtime file grows past ${MAX_LINES} lines, and the listed ones only shrink`, () => {
    const names = new Set([...sizes.keys(), ...Object.keys(OVER_CEILING)]);
    const problems = [...names].flatMap((f) => sizeProblem(f, sizes.get(f), OVER_CEILING[f]) ?? []);
    expect(problems).toEqual([]);
  });

  it('lists the largest file first (keep the entries in order)', () => {
    const counts = Object.values(OVER_CEILING);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  // Control: the ratchet refuses what it must.
  it.each([
    ['a new file over the ceiling', 'x.ts', 801, undefined, /over the 800-line ceiling/],
    ['a new file at the ceiling', 'x.ts', 800, undefined, null],
    ['a listed file that grew', 'x.ts', 1001, 1000, /grew to 1001 lines \(listed at 1000\)/],
    ['a listed file unchanged', 'x.ts', 1000, 1000, null],
    ['a listed file a little smaller', 'x.ts', 950, 1000, null],
    ['a listed file much smaller', 'x.ts', 949, 1000, /lower its entry from 1000 to 949/],
    ['a listed file within the ceiling', 'x.ts', 790, 820, /remove its entry/],
    ['a listed file that is gone', 'x.ts', undefined, 1000, /gone — remove its entry/],
  ] as const)('%s', (_why, file, lines, entry, expected) => {
    const problem = sizeProblem(file, lines, entry);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });

  it('counts lines as wc -l does', () => {
    expect([lineCount(''), lineCount('a\n'), lineCount('a\nb\n'), lineCount('a\nb')]).toEqual([0, 1, 2, 2]);
  });
});
