import path from 'node:path';
import { committableFiles, readText } from '../lib/repo';

// Runtime code reaches another workspace package only through that package's declared entry points (`exports` in its
// package.json): `@adminforge/api/tooling`, never `@adminforge/api/src/db/client` or `../../api/src/db/client`.
// Anything under `src/` is internal even when `exports` maps it — `./src/*` is there for the tests, which may import
// internals (tests/ is not scanned). A new entry point is a deliberate `exports` entry, not a deep import.

interface Workspace {
  name: string;
  /** Repository-relative directory, e.g. `portal/apps/api`. */
  root: string;
  /** `exports` keys, e.g. `.`, `./tooling`, `./src/*`, `./echarts/*.json`. */
  entries: string[];
}

const files = committableFiles();
const workspaces: Workspace[] = files
  .filter((f) => /^portal\/.+\/package\.json$/.test(f) && !f.includes('/node_modules/'))
  .map((f) => {
    const pkg = JSON.parse(readText(f) ?? '{}') as { name?: string; exports?: unknown };
    const entries =
      typeof pkg.exports === 'string'
        ? ['.']
        : pkg.exports && typeof pkg.exports === 'object'
          ? Object.keys(pkg.exports)
          : [];
    return { name: pkg.name ?? '', root: path.posix.dirname(f), entries };
  })
  .filter((w) => w.name.startsWith('@adminforge/'));

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const runtime = files.filter((f) => f.startsWith('portal/') && CODE.test(f) && !f.includes('/node_modules/'));

/** Module specifiers in static and dynamic imports, re-exports and `require` calls. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*['"]([^'"\n]+)['"]/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

const owner = (file: string) =>
  workspaces
    .filter((w) => file === w.root || file.startsWith(`${w.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An `exports` key matches a subpath exactly, or with `*` standing for one or more characters. */
const matchesEntry = (entry: string, subpath: string) =>
  entry.includes('*')
    ? new RegExp(`^${entry.split('*').map(escapeRegExp).join('.+')}$`).test(subpath)
    : entry === subpath;

/** Why `spec`, imported from `file`, reaches into another package's internals — or null when it doesn't. */
function deepImport(file: string, spec: string, all: Workspace[] = workspaces): string | null {
  const from = owner(file);
  if (spec.startsWith('.')) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    const into = all
      .filter((w) => target === w.root || target.startsWith(`${w.root}/`))
      .sort((a, b) => b.root.length - a.root.length)[0];
    return into && into.name !== from?.name ? `reaches into ${into.name} by a relative path` : null;
  }
  const pkg = all
    .filter((w) => spec === w.name || spec.startsWith(`${w.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!pkg || pkg.name === from?.name) return null;
  const subpath = `.${spec.slice(pkg.name.length)}`;
  if (subpath === './src' || subpath.startsWith('./src/')) return `imports ${pkg.name}'s internals (src/)`;
  return pkg.entries.some((e) => matchesEntry(e, subpath))
    ? null
    : `${pkg.name} declares no "${subpath}" entry point (exports in its package.json)`;
}

describe('runtime code uses other packages only through their entry points', () => {
  it('finds the workspace packages and the runtime files', () => {
    expect(workspaces.map((w) => w.name)).toEqual(
      expect.arrayContaining(['@adminforge/api', '@adminforge/schemas', '@adminforge/web']),
    );
    expect(runtime.length).toBeGreaterThan(100);
  });

  it('no runtime file deep-imports another workspace package', () => {
    const hits = runtime.flatMap((f) =>
      specifiers(readText(f) ?? '').flatMap((spec) => {
        const why = deepImport(f, spec);
        return why ? [`${f}: '${spec}' ${why}`] : [];
      }),
    );
    expect(hits).toEqual([]);
  });

  // Control: the rule refuses what it must and allows the declared entry points.
  it.each([
    ['portal/apps/scheduler/src/main.ts', '@adminforge/api/tooling', null],
    ['portal/apps/scheduler/src/one-shot.ts', '@adminforge/api/tooling/scheduler', null],
    ['portal/apps/web/src/main.tsx', '@adminforge/ui', null],
    ['portal/apps/web/src/main.tsx', '@adminforge/ui/styles/base.css', null],
    ['portal/apps/web/src/main.tsx', '@adminforge/design-tokens/echarts/steel.json', null],
    ['portal/apps/api/src/app.ts', './routes/runs', null],
    ['portal/apps/api/src/app.ts', '@adminforge/api/src/db/client', null],
    ['portal/apps/scheduler/src/main.ts', '@adminforge/api/src/db/client', /internals \(src\/\)/],
    ['portal/apps/scheduler/src/main.ts', '@adminforge/api/src/runs', /internals \(src\/\)/],
    ['portal/tools/cli/src/index.ts', '@adminforge/runner/src/config', /internals \(src\/\)/],
    [
      'portal/apps/web/src/main.tsx',
      '@adminforge/schemas/dist/index.js',
      /declares no "\.\/dist\/index\.js"/,
    ],
    ['portal/apps/scheduler/src/main.ts', '../../api/src/db/client', /reaches into @adminforge\/api/],
    ['portal/packages/widgets/src/index.ts', '../../ui/src/primitives/Chart', /reaches into @adminforge\/ui/],
  ] as const)('%s → %s', (file, spec, expected) => {
    const why = deepImport(file, spec);
    if (expected === null) expect(why).toBeNull();
    else expect(why).toMatch(expected);
  });

  it('reads every kind of import', () => {
    expect(
      specifiers(
        [
          "import a from '@x/a';",
          "import type { B } from '@x/b';",
          "export { c } from '@x/c';",
          "import '@x/d';",
          "const e = await import('@x/e');",
          "const f = require('@x/f');",
        ].join('\n'),
      ),
    ).toEqual(expect.arrayContaining(['@x/a', '@x/b', '@x/c', '@x/d', '@x/e', '@x/f']));
  });
});
