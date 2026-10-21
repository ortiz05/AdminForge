import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';

// The Claude Code kit (.claude/skills, .claude/agents) is how engineers extend AdminForge, so its shape is held like
// code (organization review O-08). Every skill follows one template — Overview · When not to use · Steps · Done when ·
// Common mistakes · See also — with frontmatter whose `name` is its folder and a "Use when …" description. Every
// repository path, skill name, agent name and `file.md` › Heading reference that a skill, an agent, docs/extending.md
// or docs/content-recipes.md cites must exist, so a rename can't silently leave Claude following a dead pointer.

const SECTIONS = [
  'Overview',
  'When not to use',
  'Steps',
  'Done when',
  'Common mistakes',
  'See also',
] as const;
const SKILLS_DIR = path.join(repoRoot, '.claude/skills');
const AGENTS_DIR = path.join(repoRoot, '.claude/agents');

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const skillNames = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const agentNames = readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

/** Files whose citations are checked: every skill and agent, and the two docs the kit links to. */
const CITING = [
  ...skillNames.map((s) => `.claude/skills/${s}/SKILL.md`),
  ...agentNames.map((a) => `.claude/agents/${a}.md`),
  'docs/extending.md',
  'docs/content-recipes.md',
];

/** `key: value` lines of the leading `---` block (single-line values only, as the skills use). */
function frontmatter(text: string): Record<string, string> | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return undefined;
  return Object.fromEntries(
    m[1]!
      .split('\n')
      .map((l) => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter((x): x is RegExpExecArray => !!x)
      .map((x) => [x[1]!, x[2]!.trim()]),
  );
}

/** `## ` headings with the text under each (up to the next `## `), outside fenced code. */
function sections(text: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const h = !fenced && /^## (.+)$/.exec(line);
    if (h) out.push({ title: h[1]!.trim(), body: '' });
    else if (out.length) out[out.length - 1]!.body += `${line}\n`;
  }
  return out;
}

/** Text without fenced code blocks (examples there aren't citations). */
const prose = (text: string) => text.replace(/^```[\s\S]*?^```/gm, '');

/** Every `inline code` span. */
const codeSpans = (text: string) => [...prose(text).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);

/** `a/{b,c}/d` → `a/b/d`, `a/c/d` (one level of braces at a time, repeatedly). */
function expandBraces(p: string): string[] {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1]!
    .split(',')
    .flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}

const TOP_LEVEL = new Set(readdirSync(repoRoot).filter((e) => e !== 'node_modules' && e !== '.git'));
/** A segment that stands for something (`<section>`, `*`, `…`, `${ … }`, `[n]`): check only what comes before it. */
const PLACEHOLDER = /[<>*…$[\]]/;

/**
 * The repository paths in a code span: tokens (a span may be a command) whose first segment is a top-level entry of
 * the checkout — `portal/…`, `tests/…`, `.claude/…`, `CLAUDE.md`. Relative paths (`src/…`, `scripts/…`), URLs, in-app
 * routes and package names are not repository paths. Each comes back cut at its first placeholder segment, without a
 * `:line` or `#anchor` suffix.
 */
function repoPaths(span: string): string[] {
  const out: string[] = [];
  for (const raw of span.split(/\s+/)) {
    const token = raw.replace(/^['"(]+|['",;)]+$/g, '').replace(/(#[\w-]*|:\d+(-\d+)?)$/, '');
    const first = token.split('/')[0]!;
    if (!TOP_LEVEL.has(first) || token.includes('://')) continue;
    for (const p of expandBraces(token)) {
      const segments = p.split('/');
      const cut = segments.findIndex((s) => PLACEHOLDER.test(s));
      const kept = (cut === -1 ? segments : segments.slice(0, cut)).filter(Boolean).join('/');
      if (kept) out.push(kept);
    }
  }
  return out;
}

/** Skill and agent names cited in code spans: `adding-a-…`, `changing-the-…`, `validating-against-…`, `…-reviewer`. */
const SKILL_NAME = /^(?:adding-an?-|changing-the-|validating-against-)[a-z0-9-]+$|^add-news-feed$/;
const AGENT_NAME = /^[a-z]+-reviewer$/;

/** Headings (any level) of a Markdown file, as plain lower-case text. */
const headingsOf = (rel: string) =>
  [...prose(read(rel)).matchAll(/^#{1,6} (.+)$/gm)].map((m) => plain(m[1]!));
const plain = (s: string) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * `` `file.md` › Heading `` (or →) references: some heading of that file must start the text after the arrow ("›
 * Quoting user data shows …"), or the text up to its first punctuation must start a heading ("› Licensed test
 * fixtures — …" for "Licensed test fixtures (opt-in)").
 */
function headingRefs(text: string): Array<{ file: string; rest: string }> {
  const flat = prose(text).replace(/\s+/g, ' ');
  return [...flat.matchAll(/`([^`\s]+\.md)` [›→] ([^`]{1,120})/g)].map((m) => ({ file: m[1]!, rest: m[2]! }));
}

describe('skills follow one template', () => {
  it('there are skills, and each folder has a SKILL.md', () => {
    expect(skillNames.length).toBeGreaterThanOrEqual(15);
    for (const s of skillNames) expect(existsSync(path.join(SKILLS_DIR, s, 'SKILL.md')), s).toBe(true);
  });

  it.each(skillNames)('%s: frontmatter name is the folder, with a "Use when" description', (skill) => {
    const fm = frontmatter(read(`.claude/skills/${skill}/SKILL.md`));
    expect(fm, 'frontmatter').toBeDefined();
    expect(fm!.name).toBe(skill);
    expect(fm!.description ?? '').toMatch(/^Use when .{40,}/);
  });

  it.each(skillNames)(
    '%s: has the six sections in order, none empty, and a "Done when" checklist',
    (skill) => {
      const found = sections(read(`.claude/skills/${skill}/SKILL.md`));
      const titles = found.map((s) => s.title);
      expect(titles.filter((t) => (SECTIONS as readonly string[]).includes(t))).toEqual([...SECTIONS]);
      for (const s of found) expect(s.body.trim(), `${skill} › ${s.title}`).not.toBe('');
      const done = found.find((s) => s.title === 'Done when')!;
      expect(done.body).toMatch(/^- \[ \] /m);
    },
  );

  it('agents have frontmatter naming their file and what they review', () => {
    expect(agentNames).toEqual(
      expect.arrayContaining(['content-reviewer', 'design-reviewer', 'security-reviewer']),
    );
    for (const a of agentNames) {
      const fm = frontmatter(read(`.claude/agents/${a}.md`));
      expect(fm?.name, a).toBe(a);
      expect((fm?.description ?? '').length, a).toBeGreaterThan(40);
    }
  });

  it('the design reviewer states the direction instead of pointing at the historical master plan', () => {
    const text = read('.claude/agents/design-reviewer.md');
    expect(text).not.toMatch(/master plan/i);
    expect(text).toContain('portal/packages/design-tokens/src/tokens.ts');
  });
});

describe('what the kit cites exists', () => {
  it.each(CITING)('%s: every repository path it cites exists', (file) => {
    const missing = codeSpans(read(file))
      .flatMap(repoPaths)
      .filter((p) => !existsSync(path.join(repoRoot, p)));
    expect([...new Set(missing)]).toEqual([]);
  });

  it.each(CITING)('%s: every skill and agent it names exists', (file) => {
    const spans = codeSpans(read(file));
    expect(spans.filter((s) => SKILL_NAME.test(s) && !skillNames.includes(s))).toEqual([]);
    expect(spans.filter((s) => AGENT_NAME.test(s) && !agentNames.includes(s))).toEqual([]);
  });

  it.each(CITING)('%s: every `file.md` › Heading reference names a heading of that file', (file) => {
    const broken = headingRefs(read(file)).filter(({ file: target, rest }) => {
      if (!existsSync(path.join(repoRoot, target))) return true;
      const text = plain(rest);
      const head = plain(rest.split(/[,;:()—.]/)[0]!);
      return !headingsOf(target).some((h) => text.startsWith(h) || (head.length > 3 && h.startsWith(head)));
    });
    expect(broken.map((b) => `${b.file} › ${b.rest.slice(0, 40)}`)).toEqual([]);
  });

  it('the Resource Graph join rule is stated once in the kit (the page skill) and linked elsewhere', () => {
    const states = (rel: string) =>
      /three `?join`?.{0,40}union|one\*{0,2} join to another table/i.test(read(rel).replace(/\s+/g, ' '));
    expect(CITING.filter(states)).toEqual(['.claude/skills/adding-a-page-or-report/SKILL.md']);
  });
});
