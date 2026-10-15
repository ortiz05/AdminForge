import path from 'node:path';
import { formatContentError, loadContentDir, type PageLike } from '@adminforge/schemas';
import { parseWidgetConfig } from '@adminforge/widgets';
import { repoRoot } from '../lib/repo';

// Every widget block in published content must match its widget's schema (docs/widgets.md), so the renderer never
// meets a block it can't draw. Unknown widget types fail here, not at runtime.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const pages = loaded.definitions.filter((d) => ['page', 'dashboard', 'report'].includes(d.def.kind));

function blocksOf(def: PageLike) {
  return [
    ...(def.layout ?? []).map((b, i) => ({ b, where: `layout[${i}]` })),
    ...(def.tabs ?? []).flatMap((t, ti) => t.layout.map((b, i) => ({ b, where: `tabs[${ti}].layout[${i}]` }))),
  ];
}

describe('widget configuration in portal/content', () => {
  it('has pages to check', () => expect(pages.length).toBeGreaterThan(0));
  // Importing @adminforge/widgets registers the widget schemas, so page validation includes widget config.
  it('loads with widget schemas registered (no widget-block errors)', () =>
    expect(loaded.errors.filter((e) => /^(layout|tabs)\b/.test(e.path)).map(formatContentError)).toEqual([]));
  it.each(pages.map((d) => [d.file, d] as const))('%s: every block matches its widget schema', (_file, d) => {
    const problems = blocksOf(d.def as PageLike).flatMap(({ b, where }) => {
      const r = parseWidgetConfig(b as { widget: string } & Record<string, unknown>);
      return r.ok ? [] : r.problems.map((p) => `${where}.${p.path} (${b.widget}): ${p.message}`);
    });
    expect(problems).toEqual([]);
  });
});
