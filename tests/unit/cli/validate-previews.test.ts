import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContentCliContext } from '@adminforge/cli/src/content/context';
import { newDefinition } from '@adminforge/cli/src/commands/new';
import { validateContent } from '@adminforge/cli/src/commands/validate';
import { repoRoot } from '../../lib/repo';

// F-11: `adminforge validate` lists the definitions flagged `preview: true` (not yet run against a live tenant, or on
// Microsoft Graph beta) after its summary, so the list never hides in a dated backlog section. Retired ones aren't
// listed; previews never fail validation.
const NAV = `kind: navigation
id: core.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
`;

async function workspace(pages: Array<{ name: string; extra?: string }>) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-previews-'));
  const contentDir = path.join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
  const lines: string[] = [];
  const ctx: ContentCliContext = {
    env: {},
    out: (l) => lines.push(l),
    repoRoot,
    contentDir,
    fixturesDir: path.join(root, 'fixtures'),
  };
  for (const p of pages) {
    const { file } = await newDefinition(ctx, 'page', `identity/${p.name}`);
    if (p.extra) writeFileSync(file, `${readFileSync(file, 'utf8')}${p.extra}`);
  }
  lines.length = 0;
  return { ctx, lines, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('adminforge validate lists previews', () => {
  it('names each preview with its file, after the summary, and still passes', async () => {
    const w = await workspace([
      { name: 'beta-thing', extra: 'preview: true\n' },
      { name: 'settled' },
      { name: 'old-preview', extra: 'preview: true\nstatus: retired\n' },
      { name: 'also-beta', extra: 'preview: true\n' },
    ]);
    try {
      expect(await validateContent(w.ctx)).toBe(true);
      const at = w.lines.findIndex((l) => l.startsWith('Preview'));
      expect(at).toBeGreaterThan(w.lines.findIndex((l) => l.startsWith('✓')));
      expect(w.lines[at]).toBe(
        'Preview — not yet run against a live tenant, or on Microsoft Graph beta (2; the page header says so):',
      );
      expect(w.lines.slice(at + 1, at + 3)).toEqual([
        '  · identity.also-beta  pages/identity/also-beta.page.yaml',
        '  · identity.beta-thing  pages/identity/beta-thing.page.yaml',
      ]);
      expect(w.lines.join('\n')).not.toContain('old-preview');
    } finally {
      w.cleanup();
    }
  });

  it('says nothing about previews when there are none', async () => {
    const w = await workspace([{ name: 'settled' }]);
    try {
      expect(await validateContent(w.ctx)).toBe(true);
      expect(w.lines.some((l) => l.startsWith('Preview'))).toBe(false);
    } finally {
      w.cleanup();
    }
  });
});
