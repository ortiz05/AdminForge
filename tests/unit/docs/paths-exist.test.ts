import { existsSync } from 'node:fs';
import path from 'node:path';
import { committableFiles, repoRoot } from '../../lib/repo';
import {
  anchors,
  codeSpanPaths,
  codeSpans,
  existsOrIgnored,
  headingChainProblem,
  headingRefs,
  headings,
  isDirectory,
  links,
  read,
  repoRootEntries,
} from './markdown';

// O-10: the files Claude Code and new engineers read first must not send them to a path, a link or a heading that
// isn't there. Stale references broke silently before (a renamed `SECURITY.md` section, a removed setup caveat). Every
// backticked repository path, every Markdown link (and its `#anchor`) and every `file.md › Heading` /
// `file.md → Heading` reference in these files must resolve. Generated, git-ignored paths (`dist/`,
// `schemas/generated/`) count as present.
const DOCS = committableFiles()
  .filter(
    (f) =>
      f === 'CLAUDE.md' ||
      f === 'docs/README.md' ||
      (f.startsWith('.claude/') && f.endsWith('.md')) ||
      (f.startsWith('docs/onboarding/') && /\.(md|txt)$/.test(f)),
  )
  .sort();

/**
 * Stale references in files another work package is rewriting at the same time (the skills package owns `.claude/**`
 * in wave 2 of the platform review). Each entry is `<doc> <path>`; the last test fails once an entry is fixed, so the
 * list only shrinks. Never add a file this package owns.
 */
const KNOWN_STALE = new Set([
  '.claude/skills/adding-a-page-or-report/SKILL.md tests/content/content-at-scale-subscription-names.test.ts',
]);

/** A Markdown file a reference names: next to the doc, else from the repository root. */
function resolveDoc(from: string, file: string): string | undefined {
  for (const rel of [path.posix.join(path.posix.dirname(from), file), file]) {
    if (existsSync(path.join(repoRoot, rel))) return path.posix.normalize(rel);
  }
  return undefined;
}

describe('documentation references resolve', () => {
  it('covers CLAUDE.md, .claude, the onboarding guides and the docs index', () => {
    expect(DOCS).toContain('CLAUDE.md');
    expect(DOCS.some((f) => f.startsWith('.claude/skills/'))).toBe(true);
    expect(DOCS.some((f) => f.startsWith('.claude/agents/'))).toBe(true);
    expect(DOCS).toContain('docs/onboarding/README.md');
    expect(DOCS).toContain('docs/README.md');
  });

  it.each(DOCS)('%s: every backticked repository path exists', (doc) => {
    const missing = codeSpans(read(doc)).flatMap(({ text, line }) =>
      codeSpanPaths(text)
        .filter((p) => !existsOrIgnored(p) && !KNOWN_STALE.has(`${doc} ${p}`))
        .map((p) => `${doc}:${line} \`${p}\``),
    );
    expect(missing).toEqual([]);
  });

  it('lists as known-stale only references that are still broken', () => {
    const stillBroken = [...KNOWN_STALE].filter((entry) => {
      const [doc, p] = entry.split(' ') as [string, string];
      return (
        DOCS.includes(doc) &&
        codeSpans(read(doc)).some(({ text }) => codeSpanPaths(text).includes(p)) &&
        !existsOrIgnored(p)
      );
    });
    expect(stillBroken, 'remove the fixed entries from KNOWN_STALE').toEqual([...KNOWN_STALE]);
  });

  it.each(DOCS)('%s: every link points at a file and heading that exist', (doc) => {
    const problems: string[] = [];
    for (const { target, line } of links(read(doc))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
      const [file, anchor] = target.split('#') as [string, string | undefined];
      const rel = file ? path.posix.normalize(path.posix.join(path.posix.dirname(doc), file)) : doc;
      const abs = path.join(repoRoot, rel);
      if (!existsSync(abs)) {
        problems.push(`${doc}:${line} ${target}: no ${rel}`);
        continue;
      }
      if (anchor && !isDirectory(abs) && rel.endsWith('.md') && !anchors(read(rel)).has(anchor)) {
        problems.push(`${doc}:${line} ${target}: no heading #${anchor} in ${rel}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(DOCS)('%s: every "file.md › Heading" reference names a heading of that file', (doc) => {
    const problems: string[] = [];
    for (const { file, rest, line } of headingRefs(read(doc))) {
      const rel = resolveDoc(doc, file);
      if (!rel) {
        problems.push(`${doc}:${line} ${file}: no such file`);
        continue;
      }
      const problem = headingChainProblem(rest, headings(read(rel)));
      if (problem) problems.push(`${doc}:${line} ${file} › … : ${problem}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the reference readers', () => {
  it('take backticked spans that start at the repository root, without placeholders', () => {
    expect(repoRootEntries().has('portal')).toBe(true);
    expect(codeSpanPaths('portal/apps/api/src/config.ts:354')).toEqual(['portal/apps/api/src/config.ts']);
    expect(codeSpanPaths('CLAUDE.md:99-101')).toEqual(['CLAUDE.md']);
    expect(codeSpanPaths('.github/{CODEOWNERS,dependabot.yml}')).toEqual([
      '.github/CODEOWNERS',
      '.github/dependabot.yml',
    ]);
    expect(codeSpanPaths('tests/unit/<package>/…')).toEqual([]);
    expect(codeSpanPaths('docs/adr/NNN-*.md')).toEqual([]);
    expect(codeSpanPaths('pnpm adminforge validate')).toEqual([]);
    expect(codeSpanPaths('schedules/jobs.ts')).toEqual([]); // relative to a package: not checked
    expect(codeSpanPaths('~/.config/adminforge/dev.env')).toEqual([]);
  });

  it('count generated, git-ignored paths as present and refuse missing ones', () => {
    expect(existsOrIgnored('portal/apps/web/dist')).toBe(true);
    expect(existsOrIgnored('portal/packages/schemas/generated/page.schema.json')).toBe(true);
    expect(existsOrIgnored('docs/no-such-guide.md')).toBe(false);
  });

  it('follow a heading chain and stop where the sentence goes on', () => {
    const h = ['Deployment, storage and network', '5. Upgrade', 'Logical copies'];
    expect(headingChainProblem('Upgrade (build and push images)', h)).toBeUndefined();
    expect(headingChainProblem('Deployment, storage and network); Firefox and', h)).toBeUndefined();
    expect(headingChainProblem('Upgrade › Logical copies', h)).toBeUndefined();
    expect(headingChainProblem('"Logical copies"', h)).toBeUndefined();
    expect(headingChainProblem('`## Unreleased` → Added', ['Unreleased', 'Added'])).toBeUndefined();
    expect(headingChainProblem('Commands) → `/p/<key>`', ['Commands'])).toBeUndefined();
    expect(headingChainProblem('Commands](../../CLAUDE.md#commands)).', ['Commands'])).toBeUndefined();
    expect(headingChainProblem('Known gaps).', ['Known gaps and accepted risks'])).toBeUndefined();
    expect(headingChainProblem('Host and network); Firefox', h)).toMatch(/no heading/);
    expect(headingChainProblem('Upgrade › Restore', h)).toMatch(/no heading/);
    expect(headingChainProblem('Signing out', ['Signing in'])).toMatch(/no heading/);
  });
});
