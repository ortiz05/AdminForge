import path from 'node:path';
import { committableFiles } from '../../lib/repo';
import { codeSpanPaths, codeSpans, links, read, withoutFences } from './markdown';

// O-01: docs/README.md is the one map of the documentation — every document, what it owns, who reads it and what
// change must update it. Before it, three partial lists (README.md, the documentation guide, the onboarding README)
// each missed documents. A document added without a row here fails this test.
const INDEX = 'docs/README.md';

/** Folders listed as one row: their files are found through the folder (and the ADR and plan indexes). */
const FOLDERS = ['docs/adr', 'docs/plans', '.claude/skills', '.claude/agents', 'docs/onboarding/templates'];

/** Every Markdown document in the repository, plus the configuration reference, folders counted once. */
function documents(): string[] {
  const files = committableFiles().filter(
    (f) => f.endsWith('.md') && f !== INDEX && !FOLDERS.some((d) => f.startsWith(`${d}/`)),
  );
  return [...files, 'config/example.env', ...FOLDERS].sort();
}

/** The repository paths the index names, from its links (relative to docs/) and its backticked paths. */
function indexed(): Set<string> {
  const text = read(INDEX);
  const out = new Set<string>();
  for (const { target } of links(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    out.add(path.posix.normalize(path.posix.join('docs', target.split('#')[0]!)).replace(/\/$/, ''));
  }
  for (const { text: span } of codeSpans(text)) for (const p of codeSpanPaths(span)) out.add(p);
  return out;
}

/** The rows of every table in the index, as trimmed cells. */
function rows(): { header: string[]; cells: string[] }[] {
  const out: { header: string[]; cells: string[] }[] = [];
  let header: string[] | undefined;
  for (const line of withoutFences(read(INDEX)).split('\n')) {
    if (!line.startsWith('|')) {
      header = undefined;
      continue;
    }
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (!header) header = cells;
    else if (!cells.every((c) => /^-+$/.test(c))) out.push({ header, cells });
  }
  return out;
}

describe('the documentation index', () => {
  it('has a row for every document', () => {
    const named = indexed();
    expect(documents().filter((d) => !named.has(d))).toEqual([]);
  });

  it('gives every row what the document owns, its audience and when to update it', () => {
    const all = rows();
    expect(all.length).toBeGreaterThanOrEqual(documents().length - 2);
    for (const { header, cells } of all) {
      expect(header).toEqual(['Doc', 'Owns', 'Audience', 'Update when']);
      expect(cells.filter((c) => c.length > 0)).toHaveLength(4);
    }
  });

  it.each(['README.md', 'docs/onboarding/README.md', 'docs/onboarding/11-documentation.md'])(
    '%s links to the index instead of keeping its own list',
    (doc) => {
      const targets = links(read(doc)).map(({ target }) =>
        path.posix.normalize(path.posix.join(path.posix.dirname(doc), target.split('#')[0]!)),
      );
      expect(targets).toContain(INDEX);
    },
  );
});
