import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// `@adminforge/schemas` has a real browser entry (design review D-21): the web bundle resolves the package to
// src/browser.ts (the `browser` export condition, or `@adminforge/schemas/browser`), whose module graph never reaches
// `yaml` or Node built-ins — instead of relying on `sideEffects: false` for tree-shaking to drop content parsing.
const SRC = path.join(repoRoot, 'portal/packages/schemas/src');
const pkg = JSON.parse(readFileSync(path.join(SRC, '../package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
};

/** Every module specifier imported or re-exported by a file (static and dynamic). */
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:import|export)\s[^;]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)].map(
    (m) => m[1] ?? m[2]!,
  );
}

function graph(entry: string): { local: Set<string>; external: Set<string> } {
  const local = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (local.has(file)) return;
    local.add(file);
    for (const s of specifiers(file)) {
      if (s.startsWith('.')) visit(path.join(path.dirname(file), `${s}.ts`));
      else external.add(s);
    }
  };
  visit(entry);
  return { local, external };
}

describe('@adminforge/schemas browser entry', () => {
  it('the package resolves to src/browser.ts in browser bundles and offers ./browser', () => {
    expect(pkg.exports['.']).toEqual({ browser: './src/browser.ts', default: './src/index.ts' });
    expect(pkg.exports['./browser']).toBe('./src/browser.ts');
  });

  it('nothing reachable from the browser entry imports yaml or a Node built-in', () => {
    const { local, external } = graph(path.join(SRC, 'browser.ts'));
    expect([...external].sort()).toEqual(['zod']);
    expect([...local].map((f) => path.basename(f))).not.toContain('parse.ts');
  });

  it('the Node entry is the browser entry plus content parsing', () => {
    expect(specifiers(path.join(SRC, 'index.ts'))).toEqual(['./browser', './parse']);
    expect(graph(path.join(SRC, 'index.ts')).external).toContain('yaml');
  });
});
