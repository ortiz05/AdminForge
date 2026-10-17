/**
 * The offline content check behind `adminforge validate` and the gate in `adminforge publish`: loads every definition
 * under the content directory and reports problems as `file:line path: message` lines.
 *
 * Errors (fail validate and block publish):
 *   - schema and cross-definition references (@adminforge/schemas `loadContentDir`);
 *   - expressions that don't compile, and the injection lint for OData, KQL and path segments
 *     (@adminforge/expressions `validateExpressions`, `lintExpressions`);
 *   - datasource rules (content/lint.ts: bare datasource names, declaration order);
 *   - runner script pins: every `script` reference's `sha256` must be the sha256 of the file under
 *     <content>/scripts (content/lint.ts `scriptPinProblems`);
 *   - `env.X` references to keys that config/example.env does not declare.
 * Warnings (printed, never fail): a `$schema` that doesn't point at the generated JSON schema, Graph beta endpoints.
 *
 * Reads files only (content, scripts, config/example.env); no network, no database, nothing in the tenant.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { collectExpressions, lintExpressions, validateExpressions } from '@adminforge/expressions';
import { formatContentError, loadContentDir, type LoadedDefinition } from '@adminforge/schemas';
import { hiddenFromContent } from './api-bridge';
import { relPath, type ContentCliContext } from './context';
import { bareDatasourceRefs, datasourceOrderProblems, scriptPinProblems } from './lint';

export interface ValidateReport {
  definitions: number;
  errors: string[];
  warnings: string[];
}

/**
 * sha256 of a script under `scriptsDir`, or null when it doesn't exist (or would resolve outside the directory).
 * Hashes the file's bytes exactly as the runner does (portal/apps/runner/src/scripts.ts). Cached per run.
 */
export function scriptHasher(scriptsDir: string): (script: string) => string | null {
  const cache = new Map<string, string | null>();
  const root = path.resolve(scriptsDir);
  return (script) => {
    if (cache.has(script)) return cache.get(script)!;
    const file = path.resolve(root, script);
    let sha: string | null = null;
    if (file.startsWith(`${root}${path.sep}`) && existsSync(file) && statSync(file).isFile())
      sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    cache.set(script, sha);
    return sha;
  };
}

/**
 * Schema, references, expression compilation, injection lint (OData, KQL, paths), datasource rules, script pins,
 * env keys, `$schema` paths. No network.
 */
export async function checkContent(
  ctx: Pick<ContentCliContext, 'contentDir' | 'repoRoot'>,
): Promise<ValidateReport & { loaded: LoadedDefinition[] }> {
  const { definitions, errors } = await loadContentDir(ctx.contentDir);
  const errs = errors.map(formatContentError);
  const warnings: string[] = [];
  const exampleFile = path.join(ctx.repoRoot, 'config', 'example.env');
  const declaredEnv = new Set(
    existsSync(exampleFile) ? (readFileSync(exampleFile, 'utf8').match(/^[A-Z0-9_]+(?==)/gm) ?? []) : [],
  );
  const schemasDir = path.join(ctx.repoRoot, 'portal', 'packages', 'schemas', 'generated');
  const scriptsDir = path.join(ctx.contentDir, 'scripts');
  const sha256Of = scriptHasher(scriptsDir);
  for (const d of definitions) {
    const at = (segments: Array<string | number>) => `${d.file}:${d.locate(segments) ?? '?'}`;
    for (const i of validateExpressions(d.def)) errs.push(`${at(i.segments)} ${i.path}: ${i.message}`);
    for (const w of lintExpressions(d.def)) errs.push(`${at(w.segments)} ${w.path}: ${w.message}`);
    for (const b of bareDatasourceRefs(d.def))
      errs.push(
        `${at(['datasources', b.datasource])} ${b.path}: uses datasource "${b.name}" without ds. — inside a datasource write ds.${b.name} (a bare name is undefined there).`,
      );
    for (const o of datasourceOrderProblems(d.def))
      errs.push(`${at(['datasources', o.datasource])} ${o.message}`);
    for (const p of scriptPinProblems(d.def, sha256Of)) {
      const script = relPath(ctx, path.join(scriptsDir, p.script));
      errs.push(
        p.actual === null
          ? `${at(p.segments)} ${p.path}: script ${script} does not exist.`
          : `${at(p.segments)} ${p.path}: pinned sha256 does not match ${script} (its sha256 is ${p.actual}) — update the pin; the runner refuses a script whose sha256 differs.`,
      );
    }
    for (const e of collectExpressions(d.def))
      for (const m of e.source.matchAll(/\benv\.([A-Za-z0-9_]+)/g))
        if (!declaredEnv.has(m[1]!))
          errs.push(`${d.file} ${e.path}: env.${m[1]} is not declared in config/example.env.`);
        else if (hiddenFromContent(m[1]!))
          // Secret-looking names (…_KEY, …TOKEN, …SECRET, …) never reach expressions: the reference is always empty.
          errs.push(
            `${d.file} ${e.path}: env.${m[1]} is never readable by content (its name looks like a secret: …SECRET, …TOKEN, …_KEY, …). Rename the setting.`,
          );
    const ref = (d.def as { $schema?: string }).$schema;
    if (
      ref &&
      path.resolve(path.dirname(path.join(ctx.contentDir, d.file)), ref) !==
        path.join(schemasDir, `${d.def.kind}.schema.json`)
    )
      warnings.push(
        `${d.file}:${d.locate(['$schema']) ?? 1} $schema should point at portal/packages/schemas/generated/${d.def.kind}.schema.json.`,
      );
    if (JSON.stringify(d.def).includes('"beta":true'))
      warnings.push(`${d.file}: uses Microsoft Graph beta (preview) endpoints.`);
  }
  return { definitions: definitions.length, errors: errs, warnings, loaded: definitions };
}
