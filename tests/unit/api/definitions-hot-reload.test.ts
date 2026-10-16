import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsDefinitionSource, type DefinitionsChanged } from '@adminforge/api/src/definitions';
import { loadContentDir } from '@adminforge/schemas';

// Development hot reload must not go quiet: Node's recursive watcher on Linux stops reporting a file once it has been
// replaced by a rename (atomic saves, `sed -i`), and a change made while a reload is running used to be dropped.
const page = (version: string) => `kind: page
id: a.one
version: ${version}
title: One
owner: test-team
template: list-detail
datasources:
  rows:
    source: static
    data: [1, 2]
layout:
  - widget: kpi
    data: rows
`;

let dir: string;
const file = () => path.join(dir, 'pages/a/one.page.yaml');
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'af-hot-'));
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), page('1.0.0'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('FsDefinitionSource hot reload', () => {
  it('keeps reloading a file after it was replaced by a rename (atomic save), then edited in place', async () => {
    const src = new FsDefinitionSource(dir, { watch: true, debounceMs: 10, pollMs: 50 });
    const changes: DefinitionsChanged[] = [];
    src.onChange((c) => changes.push(c));
    await src.list();
    const version = async () => (await src.get('page', 'a.one'))?.version;

    // Atomic save: write a temporary file, rename it over the definition.
    writeFileSync(path.join(dir, 'pages/a/.one.tmp'), page('1.1.0'));
    renameSync(path.join(dir, 'pages/a/.one.tmp'), file());
    await waitFor(async () => (await version()) === '1.1.0');
    // In-place edits of the replaced file (the watcher may no longer see them; the poll does).
    writeFileSync(file(), page('1.2.10'));
    await waitFor(async () => (await version()) === '1.2.10');
    writeFileSync(file(), page('1.3.0'));
    await waitFor(async () => (await version()) === '1.3.0');
    expect(changes.every((c) => c.keys?.length === 1 && c.keys[0] === 'page:a.one')).toBe(true);
    await src.close();
  });

  it('polls without a usable watcher too, and stops when closed', async () => {
    const src = new FsDefinitionSource(dir, { watch: true, debounceMs: 10, pollMs: 40 });
    await src.list();
    writeFileSync(file(), page('2.0.10'));
    await waitFor(async () => (await src.get('page', 'a.one'))?.version === '2.0.10');
    await src.close();
    writeFileSync(file(), page('3.0.0'));
    await new Promise((r) => setTimeout(r, 200));
    expect((await src.get('page', 'a.one'))?.version).toBe('2.0.10');
  });

  it('a reload asked for while one is running runs again afterwards instead of being dropped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    let firstReloadRead = false;
    const loader: typeof loadContentDir = async (d, o) => {
      const n = ++calls;
      const r = await loadContentDir(d, o);
      if (n === 2) {
        firstReloadRead = true; // the first reload has read the old file and is still busy
        await gate;
      }
      return r;
    };
    const src = new FsDefinitionSource(dir, { loader });
    await src.list(); // call 1
    const first = src.reload(); // call 2: reads 1.0.0, then waits
    await waitFor(() => firstReloadRead);
    writeFileSync(file(), page('1.0.1')); // changed while the first reload runs
    const second = src.reload();
    release();
    expect(await first).toEqual({ keys: [] });
    expect(await second).toEqual({ keys: ['page:a.one'] });
    expect(calls).toBe(3);
    expect((await src.get('page', 'a.one'))?.version).toBe('1.0.1');
    await src.close();
  });
});
