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
 *   - `env.X` references to keys that config/example.env does not declare;
 *   - Graph writes naming a user after `/users/` by anything but `$guid()` (content/lint.ts `usersWriteProblems`);
 *   - a file outside the folder its id names (`folderPrefixProblem`: folder = id prefix, portal/content/README.md).
 * Warnings (printed, never fail): a `$schema` that doesn't point at the generated JSON schema, Graph beta endpoints,
 * a `compensate` that can never run (`unreachableCompensations`).
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
import { bareDatasourceRefs, datasourceOrderProblems, scriptPinProblems, usersWriteProblems } from './lint';
import { SCAFFOLD_KINDS } from './scaffold';

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

/** What the folder rule reads of a definition. */
interface Placed {
  kind: string;
  id: string;
  nav?: { section?: string };
}

const prefixOf = (id: string) => id.slice(0, id.indexOf('.'));

/**
 * The folder (under the content directory) a definition belongs in: `<kind folder>/<id prefix>` — `pages/identity`
 * for `identity.users` — or the kind folder itself when the prefix is its name (`probes.dns-mx` in `probes`,
 * `feeds.m365-roadmap` in `feeds`). `adminforge new` writes there (content/scaffold.ts). Null for the navigation,
 * which is `navigation.yaml` at the content root.
 */
export function expectedFolder(def: Pick<Placed, 'kind' | 'id'>): string | null {
  if (!Object.hasOwn(SCAFFOLD_KINDS, def.kind)) return null;
  const top: string = SCAFFOLD_KINDS[def.kind as keyof typeof SCAFFOLD_KINDS];
  const prefix = prefixOf(def.id);
  return prefix === top ? top : `${top}/${prefix}`;
}

/**
 * Folders that also hold definitions whose id prefix isn't the folder's name. They predate the rule and stay:
 * nothing moves (O-05), and ids never change once published (saved views, schedules, runs, approvals and the audit
 * log key on them). Short on purpose — new content follows the rule; tests/unit/cli/content-folder-prefix.test.ts
 * fails when an entry no longer holds a file. portal/content/README.md lists them.
 */
export const FOLDER_EXCEPTIONS: ReadonlyArray<{
  folder: string;
  /** The ids it holds, for people. */
  ids: string;
  why: string;
  holds: (def: Placed) => boolean;
}> = [
  {
    folder: 'dashboards',
    ids: '<nav.section>.*',
    why: 'the section overview dashboards (`dashboards/exchange.dashboard.yaml` is `exchange.overview`)',
    holds: (d) => d.kind === 'dashboard' && d.nav?.section === prefixOf(d.id),
  },
  {
    folder: 'schedules/probes',
    ids: 'sweep.*',
    why: 'the probe sweeps: schedules are filed by job, and these run probes by tag',
    holds: (d) => d.kind === 'schedule' && prefixOf(d.id) === 'sweep',
  },
  {
    folder: 'connections',
    ids: 'integrations.*',
    why: '`integrations.hr-sync`, filed before connections had section folders',
    holds: (d) => d.kind === 'connection' && prefixOf(d.id) === 'integrations',
  },
];

/**
 * The folder rule: null when `file` (relative to the content directory, forward slashes) sits in the folder its id
 * names or in a listed exception, else the message — which names the folder it belongs in.
 */
export function folderPrefixProblem(file: string, def: Placed): string | null {
  const expected = expectedFolder(def);
  if (expected === null) return null;
  const folder = path.posix.dirname(file);
  if (folder === expected) return null;
  if (FOLDER_EXCEPTIONS.some((e) => e.folder === folder && e.holds(def))) return null;
  return `${def.id} belongs in ${expected}/ — a definition's folder is its id prefix (portal/content/README.md). Move the file: a published id never changes.`;
}

/** A step as the compensation rule reads it. */
interface FlowStep {
  id?: string;
  type?: string;
  onError?: string;
  compensate?: unknown;
  then?: unknown;
  else?: unknown;
  steps?: unknown;
}

/** A `compensate` block that can never run: where it is, and its step as `steps.<id>[.<id>…]` (or `sections.<id>…`). */
export interface UnreachableCompensation {
  segments: Array<string | number>;
  path: string;
}

/**
 * The `compensate` blocks of a playbook or runbook that can never run. The engine undoes completed steps only when a
 * step with `onError: compensate` fails (engine.ts › `policy`, `finishCompensation`): a leaf step, or a branch or
 * forEach whose steps failed. So a step's `compensate` runs only if such a step can fail after the step completed —
 * one written after it, a branch or forEach around it, or any step of a forEach around it (a later item can fail).
 * Generous on purpose (a step in a branch's other arm counts as after it): this backs a warning, never a false one.
 */
export function unreachableCompensations(def: {
  steps?: unknown;
  sections?: unknown;
}): UnreachableCompensation[] {
  interface Node {
    step: FlowStep;
    segments: Array<string | number>;
    ids: string[];
    ancestors: Node[];
    index: number;
    /** Index after its last descendant. */
    end: number;
  }
  const nodes: Node[] = [];
  const visit = (steps: unknown, at: Array<string | number>, ids: string[], ancestors: Node[]) => {
    if (!Array.isArray(steps)) return;
    steps.forEach((s: FlowStep, i) => {
      if (!s || typeof s !== 'object') return;
      const node: Node = {
        step: s,
        segments: [...at, i],
        ids: [...ids, String(s.id)],
        ancestors,
        index: nodes.length,
        end: 0,
      };
      nodes.push(node);
      const inner = [...ancestors, node];
      if (s.type === 'branch') {
        visit(s.then, [...at, i, 'then'], node.ids, inner);
        visit(s.else, [...at, i, 'else'], node.ids, inner);
      }
      if (s.type === 'forEach') visit(s.steps, [...at, i, 'steps'], node.ids, inner);
      node.end = nodes.length;
    });
  };
  visit(def.steps, ['steps'], ['steps'], []);
  if (Array.isArray(def.sections))
    def.sections.forEach((sec: { id?: string; steps?: unknown }, i) =>
      visit(sec?.steps, ['sections', i, 'steps'], ['sections', String(sec?.id)], []),
    );
  const fails = (n: Node) => n.step.onError === 'compensate';
  const within = (n: Node) => nodes.slice(n.index + 1, n.end);
  return nodes
    .filter(
      (n) =>
        n.step.compensate &&
        !nodes.slice(n.end).some(fails) &&
        !n.ancestors.some(fails) &&
        !n.ancestors.some((a) => a.step.type === 'forEach' && within(a).some(fails)),
    )
    .map((n) => ({ segments: [...n.segments, 'compensate'], path: [...n.ids, 'compensate'].join('.') }));
}

/**
 * Schema, references, expression compilation, injection lint (OData, KQL, paths), datasource rules, script pins,
 * env keys, folders, `$schema` paths. No network.
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
    for (const u of usersWriteProblems(d.def)) errs.push(`${at(u.segments)} ${u.path}: ${u.message}`);
    const misplaced = folderPrefixProblem(d.file, d.def);
    if (misplaced) errs.push(`${at(['id'])} id: ${misplaced}`);
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
    if ((d.def.kind === 'playbook' || d.def.kind === 'runbook') && d.def.status !== 'retired')
      for (const u of unreachableCompensations(d.def as { steps?: unknown; sections?: unknown }))
        warnings.push(
          `${at(u.segments)} ${u.path}: never runs — completed steps are undone only when a step after them fails with onError: compensate, and none can. Add onError: compensate to a later step, or remove the block and say how to undo the change (playbook skill, step 4).`,
        );
  }
  return { definitions: definitions.length, errors: errs, warnings, loaded: definitions };
}
