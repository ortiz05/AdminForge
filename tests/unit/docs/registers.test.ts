import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';
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
  withoutFences,
} from './markdown';

// O-02: the backlog and the licensing review were journals. Every session appended a dated section (the backlog had 18
// sections, 10 of them dated; the licensing review 16 dated findings, with lines up to 1,752 characters), nothing was
// consolidated, and "is this already known?" took a full read. The backlog is now a register — one table per area,
// one row per open item — and the licensing review the current feature → licence map, each dated finding a file of
// its own under docs/licensing/findings/. These tests keep them that way.
const BACKLOG = 'docs/backlog.md';
const MAP = 'docs/licensing-review.md';
const FINDINGS = 'docs/licensing/findings';

const AREAS = [
  'Security',
  'Engine and runs',
  'Content',
  'Web and UX',
  'API',
  'CLI and tooling',
  'Deployment and Kubernetes',
  'Tests and CI',
  'Docs',
];
const HEADER = ['Item', 'Status', 'Since', 'Owner type', 'Link'];
const STATUS = /^(open|blocked|deferred|decide|retired)(?:, (high|medium|low))?$/;
const OWNER_TYPES = new Set(['code', 'content', 'docs', 'live', 'owner']);
const DATED = /\d{4}-\d{2}-\d{2}/;
const MAX_LINE = 300;
const FINDING_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const findings = (): string[] =>
  readdirSync(path.join(repoRoot, FINDINGS))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `${FINDINGS}/${f}`);

/** A table line's cells; `\|` stays inside its cell. */
const cells = (line: string): string[] =>
  line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** The `##` sections of a doc (outside fences): heading and the lines under it, up to the next `##`. */
function sections(markdown: string): { heading: string; lines: string[] }[] {
  const out: { heading: string; lines: string[] }[] = [];
  for (const line of withoutFences(markdown).split('\n')) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) out.push({ heading: h2[1]!, lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}

/** The rows of the one table in an area section, as cells (header and separator excluded). */
function rows(lines: string[]): string[][] {
  return lines
    .filter((l) => l.startsWith('|'))
    .slice(2)
    .map(cells);
}

const isoDay = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

describe('the backlog is a register by area', () => {
  const text = read(BACKLOG);
  const areas = sections(text);

  it('has no dated heading', () => {
    expect(headings(text).filter((h) => DATED.test(h))).toEqual([]);
  });

  it('is the nine areas, in order', () => {
    expect(areas.map((a) => a.heading)).toEqual(AREAS);
  });

  it.each(AREAS)('%s is one table: item · status · since · owner type · link', (area) => {
    const lines = areas.find((a) => a.heading === area)!.lines.filter((l) => l.trim() !== '');
    // Nothing but the table (and the line that keeps Prettier from padding it): an item is a row, never prose.
    const other = lines.filter((l) => !l.startsWith('|') && l.trim() !== '<!-- prettier-ignore -->');
    expect(other).toEqual([]);
    const table = lines.filter((l) => l.startsWith('|'));
    expect(cells(table[0]!)).toEqual(HEADER);
    expect(cells(table[1]!).every((c) => /^:?-+:?$/.test(c))).toBe(true);
    expect(table.length).toBeGreaterThan(2);
  });

  it('keeps every open item in an area table: no checklist items anywhere', () => {
    const checklist = withoutFences(text)
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s*[-*+]\s+\[[ xX]\]/.test(line));
    expect(checklist.map(({ n, line }) => `${BACKLOG}:${n} ${line.trim().slice(0, 60)}`)).toEqual([]);
  });

  it('gives every row an item, a known status, the day it was recorded, an owner type and a link', () => {
    const problems: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const { heading, lines } of areas) {
      for (const row of rows(lines)) {
        const [item = '', status = '', since = '', owner = '', link = ''] = row;
        const what = `${heading}: ${item.slice(0, 50)}`;
        if (row.length !== HEADER.length) problems.push(`${what}: ${row.length} cells`);
        if (!item) problems.push(`${what}: no item`);
        if (!STATUS.test(status)) problems.push(`${what}: status "${status}"`);
        if (status.startsWith('retired') && heading !== 'Content')
          problems.push(`${what}: retired outside Content`);
        if (!isoDay(since) || since > today) problems.push(`${what}: since "${since}"`);
        if (!OWNER_TYPES.has(owner)) problems.push(`${what}: owner type "${owner}"`);
        if (!link) problems.push(`${what}: no link`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('records each item once', () => {
    const items = areas.flatMap(({ lines }) => rows(lines).map((r) => r[0]!.toLowerCase()));
    expect(items.filter((item, i) => items.indexOf(item) !== i)).toEqual([]);
  });
});

describe('the licensing review is the feature → licence map', () => {
  const text = read(MAP);

  it(`keeps every line under ${MAX_LINE} characters`, () => {
    const long = text
      .split('\n')
      .map((line, i) => ({ length: line.length, n: i + 1 }))
      .filter(({ length }) => length > MAX_LINE);
    expect(long.map(({ n, length }) => `${MAP}:${n} (${length})`)).toEqual([]);
  });

  it('has no dated heading: the dated findings are files of their own', () => {
    expect(headings(text).filter((h) => DATED.test(h))).toEqual([]);
  });

  it('links every finding', () => {
    const linked = new Set(
      links(text).map(({ target }) => path.posix.normalize(path.posix.join('docs', target.split('#')[0]!))),
    );
    expect(findings().length).toBeGreaterThan(0);
    expect(findings().filter((f) => !linked.has(f))).toEqual([]);
  });

  it('names each finding by its date and topic, with its lines wrapped', () => {
    const problems: string[] = [];
    for (const f of findings()) {
      if (!FINDING_NAME.test(path.basename(f))) problems.push(`${f}: name`);
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (line.length > MAX_LINE) problems.push(`${f}:${i + 1} (${line.length})`);
        });
    }
    expect(problems).toEqual([]);
  });
});

describe('the registers point at things that exist', () => {
  const docs = () => [BACKLOG, MAP, ...findings()];

  it.each(docs())(
    '%s: links, anchors, backticked paths and "file.md › Heading" references resolve',
    (doc) => {
      const text = read(doc);
      const problems: string[] = [];
      for (const { target, line } of links(text)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
        const [file, anchor] = target.split('#') as [string, string | undefined];
        const rel = file ? path.posix.normalize(path.posix.join(path.posix.dirname(doc), file)) : doc;
        const abs = path.join(repoRoot, rel);
        if (!existsSync(abs)) problems.push(`${doc}:${line} ${target}: no ${rel}`);
        else if (anchor && !isDirectory(abs) && rel.endsWith('.md') && !anchors(read(rel)).has(anchor))
          problems.push(`${doc}:${line} ${target}: no heading #${anchor} in ${rel}`);
      }
      for (const { text: span, line } of codeSpans(text))
        for (const p of codeSpanPaths(span))
          if (!existsOrIgnored(p)) problems.push(`${doc}:${line} \`${p}\``);
      for (const { file, rest, line } of headingRefs(text)) {
        const rel = [path.posix.join(path.posix.dirname(doc), file), file].find((r) =>
          existsSync(path.join(repoRoot, r)),
        );
        const problem = rel ? headingChainProblem(rest, headings(read(rel))) : 'no such file';
        if (problem) problems.push(`${doc}:${line} ${file} › … : ${problem}`);
      }
      expect(problems).toEqual([]);
    },
  );
});
