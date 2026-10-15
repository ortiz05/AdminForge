import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';
import type { z } from 'zod';
import { formatPath, KINDS } from './common';
import { schemaForKind, type Definition } from './definition';
import {
  validateReferences,
  type ContentError,
  type DefinitionEntry,
  type Locate,
  type PathSegment,
} from './references';

export type ParseResult =
  { ok: true; def: Definition; locate: Locate } | { ok: false; errors: ContentError[] };

export interface LoadedDefinition extends DefinitionEntry {
  /** Path relative to the content dir, with forward slashes. */
  file: string;
  def: Definition;
  /** sha256 of the file text (publishing is idempotent per sha256). */
  sha256: string;
  locate: Locate;
}

export interface LoadResult {
  definitions: LoadedDefinition[];
  errors: ContentError[];
}

const KIND_SET = new Set<string>(KINDS);
const FILE_KIND = /(?:^|[/\\])[^/\\]+\.([a-z]+)\.ya?ml$/;

/** Builds a path → line lookup over a parsed YAML document. */
function locator(doc: ReturnType<typeof parseDocument>, lc: LineCounter): Locate {
  const lineOf = (node: YamlNode | null | undefined) =>
    node?.range ? lc.linePos(node.range[0]).line : undefined;
  return (path) => {
    let node = doc.contents as YamlNode | null;
    let line = lineOf(node);
    for (const seg of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) =>
          isScalar(p.key) ? String(p.key.value) === String(seg) : p.key === seg,
        );
        if (!pair) break;
        line = lineOf(pair.key as YamlNode) ?? line;
        node = pair.value as YamlNode | null;
      } else if (isSeq(node) && typeof seg === 'number') {
        const item = node.items[seg] as YamlNode | undefined;
        if (!item) break;
        line = lineOf(item) ?? line;
        node = item;
      } else break;
    }
    return line;
  };
}

function issueToError(file: string, issue: z.core.$ZodIssue, locate: Locate): ContentError {
  const path = issue.path.filter((p): p is PathSegment => typeof p !== 'symbol');
  // Point unknown keys at the key itself.
  const at = issue.code === 'unrecognized_keys' && issue.keys[0] ? [...path, issue.keys[0]] : path;
  return { file, path: formatPath(path), line: locate(at), message: issue.message };
}

function validateObject(raw: unknown, file: string, locate: Locate): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return {
      ok: false,
      errors: [{ file, path: '', line: 1, message: 'Expected a mapping (key: value) at the top level.' }],
    };
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !KIND_SET.has(kind))
    return {
      ok: false,
      errors: [
        { file, path: 'kind', line: locate(['kind']), message: `kind must be one of: ${KINDS.join(', ')}` },
      ],
    };
  const fileKind = FILE_KIND.exec(file)?.[1];
  if (fileKind && KIND_SET.has(fileKind) && fileKind !== kind)
    return {
      ok: false,
      errors: [
        {
          file,
          path: 'kind',
          line: locate(['kind']),
          message: `File name says ${fileKind} but kind is ${kind}.`,
        },
      ],
    };
  const result = schemaForKind(kind)!.safeParse(raw);
  if (!result.success)
    return { ok: false, errors: result.error.issues.map((i) => issueToError(file, i, locate)) };
  return { ok: true, def: result.data as Definition, locate };
}

/**
 * Parses and validates one YAML definition. Errors carry the file, a dotted path and, where possible, the source line.
 */
export function parseDefinition(text: string, file: string): ParseResult {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    const lines = text.split('\n');
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const line = lc.linePos(e.pos[0]).line || undefined;
        const src = line ? (lines[line - 1] ?? '') : '';
        const hint = src.includes('${')
          ? ' Quote values that contain ${ … } together with ": ", " #", or flow characters ({ } [ ] ,).'
          : '';
        return { file, path: '', line, message: `YAML: ${e.message.split('\n')[0]}${hint}` };
      }),
    };
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch (e) {
    return { ok: false, errors: [{ file, path: '', line: 1, message: `YAML: ${(e as Error).message}` }] };
  }
  return validateObject(raw, file, locator(doc, lc));
}

/** Validates an already-parsed definition (portal drafts, API payloads). Lines are unknown. */
export function validateDefinition(value: unknown, file = '<object>'): ParseResult {
  return validateObject(value, file, () => undefined);
}

const SKIP_DIRS = new Set(['node_modules', 'fixtures', 'scripts']);

/**
 * Loads every `*.yaml` / `*.yml` under `dir` (recursively; skips dot-dirs, fixtures/ and scripts/), validates each,
 * then checks ids and cross-references across files. Node only.
 */
export async function loadContentDir(dir: string, opts: { references?: boolean } = {}): Promise<LoadResult> {
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');

  const files: string[] = [];
  const walk = async (abs: string) => {
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && /\.ya?ml$/.test(e.name)) files.push(full);
    }
  };
  await walk(dir);

  const definitions: LoadedDefinition[] = [];
  const errors: ContentError[] = [];
  for (const full of files) {
    const rel = path.relative(dir, full).split(path.sep).join('/');
    const text = await readFile(full, 'utf8');
    const r = parseDefinition(text, rel);
    if (r.ok)
      definitions.push({
        file: rel,
        def: r.def,
        locate: r.locate,
        sha256: createHash('sha256').update(text).digest('hex'),
      });
    else errors.push(...r.errors);
  }
  if (opts.references !== false) errors.push(...validateReferences(definitions));
  return { definitions, errors };
}

/** `file:line path: message` — the format the CLI and tests print. */
export function formatContentError(e: ContentError): string {
  return `${e.file}${e.line ? `:${e.line}` : ''}${e.path ? ` ${e.path}` : ''}: ${e.message}`;
}
