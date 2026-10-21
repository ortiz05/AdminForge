import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// A definition retired in favour of another one needs no "how to bring it back" row in docs/backlog.md: its summary
// names the replacement, which is the way back (docs/content-recipes.md › Versions, previews and retiring; content
// review N7). So that summary names an active definition by id, or a built-in screen by its path
// (`automation.monitoring`: "replaced by the Synthetic monitoring screen (/monitoring)"; a screen isn't a definition,
// so that retirement keeps its backlog row, which says how to bring the dashboard back).
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const defs = loaded.definitions.map((d) => d.def as { id: string; status?: string; summary?: unknown });
const active = new Set(defs.filter((d) => d.status !== 'retired').map((d) => d.id));
const replaced = defs.filter(
  (d) =>
    d.status === 'retired' &&
    typeof d.summary === 'string' &&
    /^Retired — (replaced by|merged into)\b/.test(d.summary),
);

describe('retired in favour of another definition', () => {
  it('there are such retirements', () => expect(replaced.length).toBeGreaterThan(4));

  it.each(replaced.map((d) => [d.id, d.summary as string]))(
    '%s names an active replacement',
    (_id, summary) => {
      const named = [...summary.matchAll(/\b[a-z0-9]+\.[a-z0-9-]+\b/g)].map((m) => m[0]);
      const screen = /\(\/[a-z][a-z-]*\)/.test(summary);
      expect(screen || named.some((id) => active.has(id))).toBe(true);
    },
  );
});
