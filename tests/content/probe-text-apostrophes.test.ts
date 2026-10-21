import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Content text uses the straight apostrophe, as YAML authors type it: the six token probes' remedies said
// "identity’s" with a typographic one (content review N2), which breaks a search for "identity's".
const RIGHT_QUOTE = String.fromCodePoint(0x2019);
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const probes = loaded.definitions
  .map(
    (d) =>
      d.def as {
        id: string;
        kind: string;
        status?: string;
        title?: string;
        summary?: string;
        remedy?: string;
      },
  )
  .filter((d) => d.kind === 'probe' && d.status !== 'retired');

describe('probe text uses straight apostrophes', () => {
  it('in titles, summaries and remedies', () => {
    expect(probes.length).toBeGreaterThan(50);
    const curly = probes.filter((p) => [p.title, p.summary, p.remedy].some((t) => t?.includes(RIGHT_QUOTE)));
    expect(curly.map((p) => p.id)).toEqual([]);
  });
});
