import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// A retired definition still shows where it is listed (Monitoring's history, the catalogues for anyone who kept a link),
// and its summary is what says why it is gone and what replaced it. Every retired summary starts with "Retired — ";
// `probes.m365-workload-incidents` (1.2.1) was the one that read as if the check still ran.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const retired = loaded.definitions
  .map((d) => d.def as { id: string; status?: string; summary?: unknown })
  .filter((d) => d.status === 'retired');

describe('retired definitions say so', () => {
  it('there are retired definitions to check', () => expect(retired.length).toBeGreaterThan(10));

  it.each(retired.map((d) => [d.id, d.summary]))(
    '%s: the summary starts with "Retired — "',
    (_id, summary) => {
      expect(typeof summary === 'string' ? summary : '').toMatch(/^Retired — \S/);
    },
  );
});
