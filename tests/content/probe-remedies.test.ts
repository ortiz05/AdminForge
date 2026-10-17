import path from 'node:path';
import { loadContentDir, type Probe } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Every active probe says what to do when it warns or fails, so an engineer looking at a red tile on Synthetic
// monitoring doesn't have to go looking for the cause and the place to fix it.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const probes = loaded.definitions
  .map((d) => d.def)
  .filter((d): d is Probe => d.kind === 'probe' && (d as { status?: string }).status !== 'retired');

describe('probe remedies', () => {
  it('every active probe has a remedy', () => {
    expect(probes.length).toBeGreaterThan(50);
    expect(probes.filter((p) => !p.remedy).map((p) => p.id)).toEqual([]);
  });

  it('remedies are plain sentences, not just a link', () => {
    for (const p of probes.filter((x) => x.remedy)) {
      expect(p.remedy!.length, p.id).toBeGreaterThan(60);
      expect(p.remedy, p.id).not.toMatch(/<[a-z]|\]\(|\$\{/);
    }
  });

  it('links that leave AdminForge go to Microsoft', () => {
    for (const p of probes.filter((x) => x.link && /^https:/.test(x.link.href)))
      expect(new URL(p.link!.href).hostname, p.id).toMatch(
        /(^|\.)(microsoft\.com|azure\.com|status\.microsoft|azure\.status\.microsoft)$/,
      );
  });
});
