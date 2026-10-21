import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// The runner and the scheduler declare only what their own code imports (S-39, D-21). An unused declaration is not
// harmless: it is one more package in the lockfile and the image to trust and patch (the runner declared `jose` and
// `pg` it never imported), and for the scheduler it hid which workspace packages it really reuses. The runner bundles
// everything it imports, so each of its dependencies must be imported by its source. The scheduler bundles the
// workspace packages and keeps its npm dependencies external for the code it bundles from the API, so only its
// `@adminforge/*` dependencies must be imported by its own source.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Bare package names imported (statically, dynamically or by `export … from`) anywhere under `src`. */
function importedPackages(app: string): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(path.join(repoRoot, app, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'".][^'"]*)['"]/g)) {
      const spec = m[1]!;
      if (spec.startsWith('node:')) continue;
      const parts = spec.split('/');
      names.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!);
    }
  }
  return names;
}

const dependencies = (app: string) =>
  Object.keys(
    (
      JSON.parse(readFileSync(path.join(repoRoot, app, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      }
    ).dependencies ?? {},
  );

describe('apps declare only the dependencies their code imports', () => {
  it('the runner imports every dependency it declares', () => {
    const imported = importedPackages('portal/apps/runner');
    expect(dependencies('portal/apps/runner').filter((d) => !imported.has(d))).toEqual([]);
  });

  it('the scheduler imports every workspace package it declares', () => {
    const imported = importedPackages('portal/apps/scheduler');
    const workspace = dependencies('portal/apps/scheduler').filter((d) => d.startsWith('@adminforge/'));
    expect(workspace.filter((d) => !imported.has(d))).toEqual([]);
  });

  it('the scheduler declares every workspace package it imports', () => {
    const declared = new Set(dependencies('portal/apps/scheduler'));
    const imported = [...importedPackages('portal/apps/scheduler')].filter((d) =>
      d.startsWith('@adminforge/'),
    );
    expect(imported.filter((d) => !declared.has(d))).toEqual([]);
  });
});
