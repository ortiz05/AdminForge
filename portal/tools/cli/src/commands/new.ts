/**
 * `adminforge new <kind> <section>/<name> [--template list-detail|dashboard|report|entity] [--owner <team>] [--force]`
 * — scaffolds a definition that validates as written, plus a synthetic fixture for DATA_MODE=fixtures.
 *
 * The YAML comes from content/scaffold.ts (with `$schema` for editor autocomplete and TODOs to fill in). Before
 * writing, it is parsed and reference-checked against the existing content (a failure there is a CLI bug, not the
 * user's), and the id must be unused. Writes the definition under portal/content and, for kinds with a datasource,
 * a fixture under tests/fixtures (never overwrites an existing fixture; the definition only with --force).
 *
 * Local files only; nothing in the tenant or the database. A bad kind, template or target is a ConfigError.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixtureKey } from '@adminforge/connectors';
import {
  formatContentError,
  loadContentDir,
  parseDefinition,
  validateReferences,
  type Navigation,
} from '@adminforge/schemas';
import { ConfigError } from '../shared/errors';
import { relPath, type ContentCliContext } from '../content/context';
import {
  PAGE_TEMPLATES,
  scaffold,
  SCAFFOLD_KINDS,
  type PageTemplate,
  type Scaffold,
  type ScaffoldKind,
} from '../content/scaffold';

/** `adminforge new <kind> <section/name> [--template …]` — valid YAML with $schema, plus a fixture stub. */
export async function newDefinition(
  ctx: ContentCliContext,
  kind: string,
  target: string,
  opts: { template?: string; owner?: string; force?: boolean } = {},
): Promise<Scaffold> {
  if (!Object.hasOwn(SCAFFOLD_KINDS, kind))
    throw new ConfigError(`Unknown kind "${kind}". Use one of: ${Object.keys(SCAFFOLD_KINDS).join(', ')}.`);
  if (opts.template && !(PAGE_TEMPLATES as readonly string[]).includes(opts.template))
    throw new ConfigError(`Unknown template "${opts.template}". Use one of: ${PAGE_TEMPLATES.join(', ')}.`);
  const existing = await loadContentDir(ctx.contentDir, { references: false });
  const nav = existing.definitions.find((d) => d.def.kind === 'navigation')?.def as Navigation | undefined;
  let s: Scaffold;
  try {
    s = scaffold({
      kind: kind as ScaffoldKind,
      target,
      template: opts.template as PageTemplate | undefined,
      owner: opts.owner,
      navSections: new Set(nav?.sections.map((x) => x.key) ?? []),
      contentDir: ctx.contentDir,
      schemasDir: path.join(ctx.repoRoot, 'portal', 'packages', 'schemas', 'generated'),
    });
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  if (existsSync(s.file) && !opts.force)
    throw new ConfigError(`${relPath(ctx, s.file)} already exists (use --force to overwrite).`);
  const file = path.relative(ctx.contentDir, s.file).split(path.sep).join('/');
  const parsed = parseDefinition(s.yaml, file);
  if (!parsed.ok)
    throw new Error(
      `Scaffold for ${kind} is invalid (a CLI bug):\n${parsed.errors.map(formatContentError).join('\n')}`,
    );
  if (existing.definitions.some((d) => d.def.id === s.id && d.file !== file))
    throw new ConfigError(
      `The id ${s.id} is already used by ${existing.definitions.find((d) => d.def.id === s.id)!.file}.`,
    );
  const refErrors = validateReferences([
    ...existing.definitions.filter((d) => d.file !== file),
    { file, def: parsed.def, locate: parsed.locate },
  ]).filter((e) => e.file === file);
  if (refErrors.length)
    throw new Error(
      `Scaffold for ${kind} has reference errors (a CLI bug):\n${refErrors.map(formatContentError).join('\n')}`,
    );
  mkdirSync(path.dirname(s.file), { recursive: true });
  writeFileSync(s.file, s.yaml);
  ctx.out(
    `✓ created ${relPath(ctx, s.file)}  (${kind} ${s.id}${s.template ? `, template ${s.template}` : ''})`,
  );
  if (s.fixture) {
    const key = fixtureKey(s.fixture.method, s.fixture.url);
    const fixtureFile = path.join(ctx.fixturesDir, key.candidates.at(-1)!);
    if (existsSync(fixtureFile))
      ctx.out(`· fixture ${relPath(ctx, fixtureFile)} already exists; left as is.`);
    else {
      mkdirSync(path.dirname(fixtureFile), { recursive: true });
      writeFileSync(fixtureFile, `${JSON.stringify(s.fixture.body, null, 2)}\n`);
      ctx.out(`✓ created ${relPath(ctx, fixtureFile)}  (synthetic data for DATA_MODE=fixtures)`);
    }
  }
  if (['page', 'dashboard', 'report'].includes(kind) && !s.navAdded && s.template !== 'entity')
    ctx.out(`· no nav: block — section "${target.split('/')[0]}" is not in navigation.yaml.`);
  ctx.out('Next: edit the TODOs, then run adminforge validate (and adminforge test for playbooks).');
  return s;
}
