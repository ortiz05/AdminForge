/**
 * Markdown reading for the docs tests in this folder (`paths-exist`, `index`, `plans-status`): the references a doc
 * makes — backticked repository paths, Markdown links (with their `#anchor`) and `file.md › Heading` /
 * `file.md → Heading` references — and the headings and GitHub anchors a target offers. Pure apart from reading files
 * under `repoRoot` and asking git which missing paths are ignored (generated output such as `dist/`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { committableFiles, repoRoot } from '../../lib/repo';

export const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/** The doc without fenced code blocks (their lines become blank, so line numbers still match). */
export function withoutFences(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === undefined && open) {
        fence = open[0]!.repeat(open.length);
        return '';
      }
      if (fence !== undefined) {
        if (line.trim().startsWith(fence)) fence = undefined;
        return '';
      }
      return line;
    })
    .join('\n');
}

/** ATX headings (`## Text`), outside code fences, as written. */
export function headings(markdown: string): string[] {
  return [...withoutFences(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]!);
}

/** GitHub's anchor for a heading: lower case, inline markup and punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor a doc offers (duplicates get GitHub's `-1`, `-2` suffixes). */
export function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const h of headings(markdown)) {
    const base = slug(h);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** A heading as people cite it: numbering, inline markup, quotes and trailing punctuation dropped, lower case. */
export function normalHeading(text: string): string {
  return text
    .replace(/[`*_"“”]/g, '')
    .replace(/^\s*#+\s*/, '')
    .replace(/^\s*\d+(?:\.\d+)*\.?\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:]+$/, '')
    .trim()
    .toLowerCase();
}

let roots: Set<string> | undefined;
/** Top-level names of the repository (`portal`, `docs`, `CLAUDE.md`, `.github`, …). */
export function repoRootEntries(): Set<string> {
  roots ??= new Set(committableFiles().map((f) => f.split('/')[0]!));
  return roots;
}

/** `a/{b,c}/d` → `a/b/d`, `a/c/d` (one level of braces, as the docs write them). */
export function expandBraces(p: string): string[] {
  const m = /^(.*?)\{([^{}]+)\}(.*)$/.exec(p);
  if (!m) return [p];
  return m[2]!.split(',').flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`));
}

/**
 * The repository paths a backticked span names, or none when it isn't one: it must start at a top-level entry of the
 * repository and carry no placeholder (`<name>`, `*`, `…`, `NNN`, `$`). A `:12` or `:12-20` line suffix and a
 * `#anchor` are dropped; braces are expanded.
 */
export function codeSpanPaths(span: string): string[] {
  const text = span.trim();
  if (!text || /\s/.test(text)) return [];
  if (/[<>*…$|=?[\]]|\.\.\.|NNN|^~|^\.\.?\//.test(text)) return [];
  const clean = text.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, '');
  const first = clean.split('/')[0]!.replace(/\{.*$/, '');
  if (!repoRootEntries().has(first)) return [];
  return expandBraces(clean).map((p) => p.replace(/\/+$/, ''));
}

/** Inline code spans of a doc outside fenced blocks, with their line numbers. */
export function codeSpans(markdown: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  withoutFences(markdown)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/(`+)([^`]+?)\1(?!`)/g)) out.push({ text: m[2]!, line: i + 1 });
    });
  return out;
}

/** Markdown links `[text](target)` outside fenced blocks (web, mail and in-page-only targets included). */
export function links(markdown: string): { target: string; line: number }[] {
  const out: { target: string; line: number }[] = [];
  withoutFences(markdown)
    .split('\n')
    .forEach((line, i) => {
      const code = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
      for (const m of code.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
        out.push({ target: m[1]!, line: i + 1 });
    });
  return out;
}

/**
 * `file.md › Heading › Sub-heading` and `file.md → Heading` references (the file optionally backticked), outside
 * fenced blocks. `rest` is the text after the first arrow, up to the end of the line.
 */
export function headingRefs(markdown: string): { file: string; rest: string; line: number }[] {
  const out: { file: string; rest: string; line: number }[] = [];
  withoutFences(markdown)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/`?([\w./-]+\.md)`?\s*[›→]\s*(.+)$/g))
        out.push({ file: m[1]!, rest: m[2]!, line: i + 1 });
    });
  return out;
}

/**
 * The first problem with a heading reference's chain (`Upgrade`, `A › B`), or undefined when every link of it names a
 * heading of the target. People write the heading and then go on with the sentence, and shorten long headings
 * ("Known gaps" for "Known gaps and accepted risks"), so a link holds when one of its leading word runs is a heading,
 * or — two words or more — the start of one. A quoted heading must match exactly.
 */
export function headingChainProblem(rest: string, targetHeadings: readonly string[]): string | undefined {
  const known = targetHeadings.map(normalHeading);
  const names = (ref: string, words: number) =>
    known.some((h) => h === ref || (words >= 2 && h.startsWith(`${ref} `)));
  let text = rest.replace(/`/g, '').trim();
  for (;;) {
    const quoted = /^["“]([^"”]+)["”]/.exec(text);
    let used: number | undefined;
    if (quoted) {
      if (!known.includes(normalHeading(quoted[1]!))) return `no heading "${quoted[1]}"`;
      used = quoted[0].length;
    } else {
      const clause = text.split(/[()|;]|\s[—–-]\s|\.(?:\s|$)|[›→]/)[0]!;
      const words = clause.trim().split(/\s+/).filter(Boolean);
      for (let n = words.length; n >= 1 && used === undefined; n--) {
        if (names(normalHeading(words.slice(0, n).join(' ')), n)) {
          used = new RegExp(`^\\s*(?:\\S+\\s+){${n - 1}}\\S+`).exec(clause)![0].length;
        }
      }
      if (used === undefined) return `no heading at "${clause.trim()}"`;
    }
    const after = text.slice(used).replace(/^[\s,.;:]*/, '');
    if (!/^[›→]/.test(after)) return undefined;
    text = after.slice(1).trim();
  }
}

/** True when the path exists, or git ignores it (generated: `dist/`, `schemas/generated/`, local settings). */
export function existsOrIgnored(rel: string): boolean {
  if (existsSync(path.join(repoRoot, rel))) return true;
  // `dist/` matches directories only, so a missing path is asked about as a file and as a directory.
  return [rel, `${rel}/`].some((candidate) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', candidate], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  });
}

export const isDirectory = (abs: string): boolean => existsSync(abs) && statSync(abs).isDirectory();
