import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { pruneBudget } from '@adminforge/api/src/housekeeping/budget';

// D-02 follow-up: report files past retention went in one sweep of every schedule folder, however many files there
// were. The sweep now works within the housekeeping pass's budget (files per batch, a time limit) and, when it runs
// out of time, the next pass goes on where it stopped — so files it keeps at the front never starve the folders after
// them.

const NOW = Date.parse('2026-10-21T12:00:00Z');
const DAY = 86_400_000;
const CUTOFF = new Date(NOW - 90 * DAY);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-artifacts-prune-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `<folder>/<n>.csv` last modified `daysAgo` days ago. */
function put(folder: string, n: number, daysAgo: number) {
  mkdirSync(path.join(dir, folder), { recursive: true });
  const file = path.join(dir, folder, `2026-01-${String(n).padStart(2, '0')}T00-00-00Z.csv`);
  writeFileSync(file, 'a,b\n');
  const at = new Date(NOW - daysAgo * DAY);
  utimesSync(file, at, at);
}

const files = (folder: string) => readdirSync(path.join(dir, folder)).sort();
/** Spent as soon as it is asked: every pass stops after its first batch. */
const spentAfterOneBatch = () => {
  let reads = 0;
  return pruneBudget({ batch: 2, clock: () => (reads++ === 0 ? 0 : 10_000) });
};

describe('report file retention within the pass budget', () => {
  it('removes everything past retention when the budget allows, and keeps the rest', async () => {
    for (let n = 1; n <= 3; n++) put('reports.a', n, 100);
    put('reports.a', 4, 10);
    put('reports.b', 1, 200);
    const store = new ArtifactStore(dir);
    const budget = pruneBudget({ batch: 2 });
    expect(await store.pruneOlderThan(CUTOFF, budget)).toBe(4);
    expect(budget.pending).toBe(false);
    expect(files('reports.a')).toEqual(['2026-01-04T00-00-00Z.csv']);
    expect(files('reports.b')).toEqual([]);
  });

  it('stops at the time budget (pending) and goes on where it stopped at the next pass', async () => {
    // Six files it keeps at the front: restarting from the top each pass would never reach reports.b.
    for (let n = 1; n <= 6; n++) put('reports.a', n, 10);
    for (let n = 1; n <= 3; n++) put('reports.b', n, 200);
    const store = new ArtifactStore(dir);
    let removed = 0;
    let passes = 0;
    for (let pending = true; pending && passes < 10; passes++) {
      const budget = spentAfterOneBatch();
      removed += await store.pruneOlderThan(CUTOFF, budget);
      pending = budget.pending;
    }
    expect(removed).toBe(3);
    expect(passes).toBe(5);
    expect(files('reports.a')).toHaveLength(6);
    expect(files('reports.b')).toEqual([]);
  });

  it('a pass that finishes the rest of a sweep starts the next one from the top', async () => {
    for (let n = 1; n <= 3; n++) put('reports.a', n, 200);
    const store = new ArtifactStore(dir);
    const first = spentAfterOneBatch();
    expect(await store.pruneOlderThan(CUTOFF, first)).toBe(2);
    expect(first.pending).toBe(true);
    // Became old meanwhile, before where the first pass stopped: the next sweep finds it.
    put('reports.a', 1, 200);
    expect(await store.pruneOlderThan(CUTOFF)).toBe(1);
    expect(files('reports.a')).toEqual(['2026-01-01T00-00-00Z.csv']);
    expect(await store.pruneOlderThan(CUTOFF)).toBe(1);
    expect(files('reports.a')).toEqual([]);
  });
});
