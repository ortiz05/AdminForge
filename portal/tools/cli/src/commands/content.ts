import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixtureKey, type GraphClient } from '@adminforge/connectors';
import { collectExpressions, lintExpressions, validateExpressions } from '@adminforge/expressions';
import {
  formatContentError,
  loadContentDir,
  parseDefinition,
  validateReferences,
  type Definition,
  type LoadedDefinition,
  type Navigation,
} from '@adminforge/schemas';
import {
  createAutomationTokenProvider,
  createDatabase,
  createOutboundExecutor,
  DatasourceRunner,
  DbDefinitionStore,
  FsDefinitionSource,
  PgAuditWriter,
  registryFrom,
  type AuditInput,
  type AutomationTokenProvider,
  type PublishEntry,
  type PublishResult,
} from '../content/api-bridge';
import { kindFromPath, Sanitizer } from '../content/sanitize';
import {
  PAGE_TEMPLATES,
  scaffold,
  SCAFFOLD_KINDS,
  type PageTemplate,
  type Scaffold,
  type ScaffoldKind,
} from '../content/scaffold';
import {
  compareScopes,
  consentedScopes,
  declaredScopes,
  provisionedScopes,
  type ScopeApp,
} from '../content/scopes';
import { AZURE_READER_ROLE_ID, DIRECTORY_ROLES, RESOURCES } from '../provision/catalog';
import type { Out } from '../provision/render';
import { ceilingSettings, ConfigError, provisionerClients, provisionSettings } from './context';

/** What the content commands need from the outside world (injected in tests). */
export interface ContentCliContext {
  env: Record<string, string | undefined>;
  out: Out;
  repoRoot: string;
  /** portal/content (CONTENT_DIR overrides). */
  contentDir: string;
  /** tests/fixtures (ADMINFORGE_FIXTURES_DIR overrides). */
  fixturesDir: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests: Graph client for --scopes instead of the provisioner identity. */
  graph?: GraphClient;
  /** Tests: automation identity for `fixtures record`. */
  automation?: Pick<AutomationTokenProvider, 'token'> | null;
  /** Tests: where publish records its audit event (default: the database's audit chain). */
  audit?: (input: AuditInput) => Promise<unknown>;
  /** Tests: publish target instead of DATABASE_URL. */
  openStore?: () => Promise<{ store: Pick<DbDefinitionStore, 'publish'>; close: () => Promise<void> }>;
  /** Tests: the engine module (runPlaybookTests). */
  engine?: EngineModule | null;
}

export function contentContext(
  env: Record<string, string | undefined>,
  out: Out,
  repoRoot: string,
): ContentCliContext {
  return {
    env,
    out,
    repoRoot,
    contentDir: path.resolve(env.CONTENT_DIR || path.join(repoRoot, 'portal', 'content')),
    fixturesDir: path.resolve(env.ADMINFORGE_FIXTURES_DIR || path.join(repoRoot, 'tests', 'fixtures')),
  };
}

const rel = (ctx: ContentCliContext, file: string) =>
  path.relative(ctx.repoRoot, file).split(path.sep).join('/');

// ── validate ──────────────────────────────────────────────────────────────────

export interface ValidateReport {
  definitions: number;
  errors: string[];
  warnings: string[];
}

/** Schema, references, expression compilation, `$filter`/`$search` lint, env keys, `$schema` paths. Pure (no network). */
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
  for (const d of definitions) {
    const at = (segments: Array<string | number>) => `${d.file}:${d.locate(segments) ?? '?'}`;
    for (const i of validateExpressions(d.def)) errs.push(`${at(i.segments)} ${i.path}: ${i.message}`);
    for (const w of lintExpressions(d.def)) errs.push(`${at(w.segments)} ${w.path}: ${w.message}`);
    for (const e of collectExpressions(d.def))
      for (const m of e.source.matchAll(/\benv\.([A-Za-z0-9_]+)/g))
        if (!declaredEnv.has(m[1]!))
          errs.push(`${d.file} ${e.path}: env.${m[1]} is not declared in config/example.env.`);
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

const APP_LABEL: Record<ScopeApp, string> = {
  read: 'Read app',
  write: 'Write app',
  automation: 'Automation identity',
};

/** `adminforge validate [--scopes]` — true when there are no errors (warnings and unused scopes don't fail). */
export async function validateContent(
  ctx: ContentCliContext,
  opts: { scopes?: boolean } = {},
): Promise<boolean> {
  const report = await checkContent(ctx);
  for (const e of report.errors) ctx.out(`✗ ${e}`);
  for (const w of report.warnings) ctx.out(`⚠ ${w}`);
  let ok = report.errors.length === 0;
  ctx.out(
    ok
      ? `✓ ${report.definitions} definitions valid (schema, references, expressions, lint, env keys).`
      : `✗ ${report.errors.length} problem(s) in ${rel(ctx, ctx.contentDir)}.`,
  );
  if (!opts.scopes) return ok;

  const declared = declaredScopes(report.loaded);
  const apps: Partial<Record<ScopeApp, string>> = {
    read: ctx.env.AF_READ_CLIENT_ID,
    write: ctx.env.AF_WRITE_CLIENT_ID,
    automation: ctx.env.AF_AUTOMATION_CLIENT_ID,
  };
  const graph =
    ctx.graph ??
    provisionerClients(
      { env: ctx.env, writeEnv: () => undefined, out: ctx.out, fetch: ctx.fetch },
      provisionSettings(ctx.env),
    ).graph;
  const { scopes: consented, notFound, present } = await consentedScopes(graph, apps);
  // Same expectation as `provision entra` (baseline, content, ceilings), so the two never disagree.
  const provisioned = provisionedScopes(ceilingSettings(ctx.env), declared.scopes);
  const { missing, unused, withheld, unlicensed, baseline } = compareScopes(
    declared,
    consented,
    provisioned,
    present,
  );
  const files = (f?: string[]) =>
    f?.length ? `  (${f.slice(0, 3).join(', ')}${f.length > 3 ? ', …' : ''})` : '';
  ctx.out('');
  ctx.out('Scopes declared by content vs. granted in Entra:');
  for (const app of ['read', 'write', 'automation'] as const)
    if (!apps[app]) ctx.out(`  ⚠ ${APP_LABEL[app]}: client id not set in the env file; not checked.`);
  for (const app of notFound)
    ctx.out(`  ✗ ${APP_LABEL[app]}: no service principal found for the configured client id.`);
  for (const m of missing)
    ctx.out(`  ✗ missing  ${APP_LABEL[m.app]} · ${m.service} · ${m.scope}${files(m.files)}`);
  for (const w of withheld)
    ctx.out(`  ⚠ withheld ${APP_LABEL[w.app]} · ${w.service} · ${w.scope} — ${w.reason}${files(w.files)}`);
  for (const u of unlicensed)
    ctx.out(
      `  ⚠ skipped  ${APP_LABEL[u.app]} · ${u.service} · ${u.scope} — workload not in this tenant (not licensed)${files(u.files)}`,
    );
  for (const u of unused)
    ctx.out(
      `  · unused   ${APP_LABEL[u.app]} · ${u.service} · ${u.scope}  (not expected by provisioning: ${u.app === 'automation' ? 'remove the app role assignment' : '`provision entra` removes it'})`,
    );
  for (const b of baseline)
    ctx.out(
      b.builtin
        ? `  · built-in ${APP_LABEL[b.app]} · ${b.service} · ${b.scope}  (${b.builtin})`
        : `  · unused   ${APP_LABEL[b.app]} · ${b.service} · ${b.scope}  (baseline in provision/catalog.ts; no content declares it)`,
    );
  if (declared.connections.length)
    ctx.out(`  · not checked (own audiences): connections ${declared.connections.join(', ')}`);
  if (!missing.length && !notFound.length)
    ctx.out('  ✓ every declared scope provisioning grants is granted.');
  ok &&= missing.length === 0 && notFound.length === 0;
  return ok;
}

// ── test ──────────────────────────────────────────────────────────────────────

/** The slice of @adminforge/engine used here (structural, so the CLI type-checks independently of the engine). */
export interface EngineModule {
  runPlaybookTests(
    def: Definition,
    opts?: {
      resolveChild?: (ref: string, version?: string) => Definition | null;
      env?: Record<string, unknown>;
    },
  ): Promise<Array<{ name: string; passed: boolean; failures: string[]; status: string }>>;
}

async function loadEngine(): Promise<EngineModule | null> {
  try {
    const mod = (await import('@adminforge/engine')) as Partial<EngineModule>;
    return typeof mod.runPlaybookTests === 'function' ? (mod as EngineModule) : null;
  } catch {
    return null;
  }
}

/** `adminforge test [pattern]` — every playbook/runbook `tests:` block, dry run with mocked step outputs. */
export async function testContent(ctx: ContentCliContext, opts: { pattern?: string } = {}): Promise<boolean> {
  const engine = ctx.engine !== undefined ? ctx.engine : await loadEngine();
  if (!engine) {
    ctx.out('⚠ The playbook engine (runPlaybookTests) is not available; no tests were run.');
    return true;
  }
  // Definitions that parsed are tested even when other files have problems (adminforge validate reports those).
  const { definitions, errors } = await loadContentDir(ctx.contentDir);
  for (const e of errors) ctx.out(`⚠ ${formatContentError(e)}`);
  const byId = new Map(definitions.map((d) => [d.def.id, d.def]));
  const targets = definitions.filter(
    (d) =>
      (d.def.kind === 'playbook' || d.def.kind === 'runbook') &&
      d.def.tests?.length &&
      (!opts.pattern || d.def.id.includes(opts.pattern) || d.file.includes(opts.pattern)),
  );
  let passed = 0;
  let failed = 0;
  for (const d of targets) {
    let results: Awaited<ReturnType<EngineModule['runPlaybookTests']>>;
    try {
      results = await engine.runPlaybookTests(d.def, { resolveChild: (ref) => byId.get(ref) ?? null });
    } catch (err) {
      failed++;
      ctx.out(`✗ ${d.def.id}: tests could not run — ${(err as Error).message}`);
      continue;
    }
    for (const r of results) {
      if (r.passed) passed++;
      else failed++;
      ctx.out(
        `${r.passed ? '✓' : '✗'} ${d.def.id} › ${r.name}${r.passed ? '' : ` — ${r.failures.join('; ')}`}`,
      );
    }
  }
  ctx.out(
    `${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed (${targets.length} definitions with tests${opts.pattern ? ` matching "${opts.pattern}"` : ''}).`,
  );
  return failed === 0;
}

// ── publish ───────────────────────────────────────────────────────────────────

/** `adminforge publish [--dry-run]` — new versions to Postgres (idempotent by sha256), then NOTIFY definitions_changed. */
export async function publishContent(
  ctx: ContentCliContext,
  opts: { dryRun?: boolean } = {},
): Promise<PublishResult | null> {
  const { definitions, errors } = await loadContentDir(ctx.contentDir);
  if (errors.length) {
    for (const e of errors) ctx.out(`✗ ${formatContentError(e)}`);
    ctx.out('✗ Nothing published: fix the content first (adminforge validate).');
    return null;
  }
  const entries: PublishEntry[] = definitions.map((d) => ({
    def: d.def,
    sha256: d.sha256,
    source: 'git',
    file: d.file,
  }));
  let target: { store: Pick<DbDefinitionStore, 'publish'>; close: () => Promise<void> };
  let audit = ctx.audit;
  if (ctx.openStore) target = await ctx.openStore();
  else {
    const url = ctx.env.DATABASE_URL;
    if (!url) throw new ConfigError('DATABASE_URL is not set in the env file.');
    const database = createDatabase(url, { max: 2 });
    target = { store: new DbDefinitionStore(database.db), close: () => database.close() };
    const writer = new PgAuditWriter(database.db, ctx.now);
    audit ??= (input) => writer.append(input);
  }
  try {
    const result = await target.store.publish(entries, { dryRun: opts.dryRun });
    // Content changes what the portal can do: who published which versions goes into the audit chain.
    const created = result.items.filter((i) => i.action === 'create');
    if (!opts.dryRun && result.applied && created.length && audit)
      await audit({
        actorOid: 'cli',
        actorUpn: publisher(),
        mode: 'write',
        action: 'content.published',
        correlationId: randomUUID(),
        targetType: 'definitions',
        targetId: `${created.length} version(s)`,
        result: 'success',
        details: {
          versions: created.map(
            (i) => `${i.kind}:${i.key}@${i.version}${i.status === 'retired' ? ' (retired)' : ''}`,
          ),
          refused: result.refused,
          git: gitState(ctx.repoRoot),
        },
      });
    for (const i of result.items) {
      if (i.action === 'unchanged') continue;
      const mark = i.action === 'create' ? (i.status === 'retired' ? '− retire' : '+ publish') : '✗ refused';
      ctx.out(
        `${mark}  ${i.kind} ${i.key} ${i.version}${i.reason ? ` — ${i.reason}` : ''}${i.file ? `  (${i.file})` : ''}`,
      );
    }
    const verb = opts.dryRun ? 'would publish' : result.applied ? 'published' : 'nothing published';
    ctx.out(
      `${result.refused ? '✗' : '✓'} ${verb}: ${result.created} new version(s), ${result.unchanged} unchanged, ${result.refused} refused${opts.dryRun ? ' (dry run)' : ''}${result.notified ? '; NOTIFY definitions_changed sent' : ''}.`,
    );
    return result;
  } finally {
    await target.close();
  }
}

/** Who ran the CLI (local account and host), for the audit trail. */
function publisher(): string {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return 'unknown@cli';
  }
}

/** The commit the content came from, and whether the working tree had uncommitted content changes. */
function gitState(repoRoot: string): { commit: string | null; dirty: boolean | null } {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  try {
    return {
      commit: git(['rev-parse', '--short=12', 'HEAD']),
      dirty: git(['status', '--porcelain', '--', 'portal/content']).length > 0,
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

// ── new ───────────────────────────────────────────────────────────────────────

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
    throw new ConfigError(`${rel(ctx, s.file)} already exists (use --force to overwrite).`);
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
  ctx.out(`✓ created ${rel(ctx, s.file)}  (${kind} ${s.id}${s.template ? `, template ${s.template}` : ''})`);
  if (s.fixture) {
    const key = fixtureKey(s.fixture.method, s.fixture.url);
    const fixtureFile = path.join(ctx.fixturesDir, key.candidates.at(-1)!);
    if (existsSync(fixtureFile)) ctx.out(`· fixture ${rel(ctx, fixtureFile)} already exists; left as is.`);
    else {
      mkdirSync(path.dirname(fixtureFile), { recursive: true });
      writeFileSync(fixtureFile, `${JSON.stringify(s.fixture.body, null, 2)}\n`);
      ctx.out(`✓ created ${rel(ctx, fixtureFile)}  (synthetic data for DATA_MODE=fixtures)`);
    }
  }
  if (['page', 'dashboard', 'report'].includes(kind) && !s.navAdded && s.template !== 'entity')
    ctx.out(`· no nav: block — section "${target.split('/')[0]}" is not in navigation.yaml.`);
  ctx.out('Next: edit the TODOs, then run adminforge validate (and adminforge test for playbooks).');
  return s;
}

// ── fixtures record ───────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  url: string;
  status: number;
  body: unknown;
}

const EXCLUDED_ENV = /SECRET|PASSWORD|TOKEN|WEBHOOK|_KEY$|CERT|TOTP|PRIVATE|^AF_TEST_|^AF_PROVISIONER_/i;

/** Values from the local env file that must never land in a fixture (same rule as the no-tenant-data guard). */
export function forbiddenValues(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || !/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (!/^(AF_|DATABASE_URL|POSTGRES_|TOKEN_CACHE_KEY|RUNNER_|ANTHROPIC_|PUBLIC_BASE_URL)/.test(key))
      continue;
    if (
      value.length >= 8 &&
      !/^(true|false|\d+|https?:\/\/localhost(:\d+)?\/?|https?:\/\/127\.0\.0\.1(:\d+)?\/?|postgres:\/\/.*@127\.0\.0\.1.*)$/i.test(
        value,
      )
    )
      out.add(value);
    if (/DOMAIN/.test(key)) out.add(value.toLowerCase());
  }
  return [...out];
}

function decodeBody(text: string, contentType: string): unknown {
  if (!text) return undefined;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return /^\d+$/.test(text.trim()) ? Number(text) : text;
}

/** Graph $batch → one fixture per sub-request (the fixture fetch answers $batch from those). */
function expand(ex: Recorded & { requestBody?: string }): Recorded[] {
  const u = new URL(ex.url);
  if (u.hostname !== 'graph.microsoft.com' || ex.method !== 'POST' || !/\/\$batch$/.test(u.pathname))
    return [ex];
  const version = u.pathname.split('/').filter(Boolean)[0] ?? 'v1.0';
  const reqs =
    (JSON.parse(ex.requestBody || '{}') as { requests?: Array<{ id: string; method?: string; url: string }> })
      .requests ?? [];
  const resps =
    (
      ex.body as
        | {
            responses?: Array<{
              id: string;
              status: number;
              headers?: Record<string, string>;
              body?: unknown;
            }>;
          }
        | undefined
    )?.responses ?? [];
  return reqs.flatMap((r) => {
    const resp = resps.find((x) => x.id === r.id);
    if (!resp) return [];
    let body = resp.body;
    const type =
      Object.entries(resp.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    if (typeof body === 'string' && /^text\/plain/i.test(type)) {
      const text = Buffer.from(body, 'base64').toString('utf8');
      body = /^\d+$/.test(text.trim()) ? Number(text) : text;
    }
    return [
      {
        method: (r.method ?? 'GET').toUpperCase(),
        url: `https://graph.microsoft.com/${version}${r.url.startsWith('/') ? '' : '/'}${r.url}`,
        status: resp.status,
        body,
      },
    ];
  });
}

const KEEP_GUIDS = [
  ...Object.values(RESOURCES).map((r) => r.appId),
  ...Object.values(DIRECTORY_ROLES),
  AZURE_READER_ROLE_ID,
  '48ac35b8-9aa8-4d74-927d-1f4a14a0b239',
  '00000003-0000-0ff1-ce00-000000000000',
];

/**
 * `adminforge fixtures record <page> [--datasource x] [--param k=v]` — reads the page's datasources live as the automation
 * identity (read-only), sanitizes every response (names, UPNs, domains, GUIDs remapped consistently) and writes fixture
 * files that DATA_MODE=fixtures serves. Existing files are kept unless --force; output that still contains a value from
 * the local env file is refused.
 */
export async function recordFixtures(
  ctx: ContentCliContext,
  pageKey: string,
  opts: { datasource?: string; params?: string[]; force?: boolean; dryRun?: boolean } = {},
): Promise<boolean> {
  const params: Record<string, unknown> = {};
  for (const p of opts.params ?? []) {
    const i = p.indexOf('=');
    if (i <= 0) throw new ConfigError(`--param expects key=value, got "${p}".`);
    params[p.slice(0, i)] = p.slice(i + 1);
  }
  const automation =
    ctx.automation !== undefined
      ? ctx.automation
      : createAutomationTokenProvider({
          AF_TENANT_ID: ctx.env.AF_TENANT_ID,
          AF_AUTOMATION_CLIENT_ID: ctx.env.AF_AUTOMATION_CLIENT_ID,
          AF_AUTOMATION_CLIENT_SECRET: ctx.env.AF_AUTOMATION_CLIENT_SECRET,
          AF_AUTOMATION_CERT_PATH: ctx.env.AF_AUTOMATION_CERT_PATH,
        });
  if (!automation)
    throw new ConfigError(
      'The automation identity is not configured (AF_TENANT_ID, AF_AUTOMATION_CLIENT_ID and AF_AUTOMATION_CERT_PATH or _SECRET).',
    );

  const recorded: Array<Recorded & { requestBody?: string }> = [];
  const base = ctx.fetch ?? fetch;
  const recorder: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const text = await res.clone().text();
    recorded.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      status: res.status,
      body: decodeBody(text, res.headers.get('content-type') ?? ''),
      requestBody: typeof init?.body === 'string' ? init.body : undefined,
    });
    return res;
  };

  const env = Object.fromEntries(
    Object.entries(ctx.env).filter(([k, v]) => /^AF_[A-Z0-9_]+$/.test(k) && v && !EXCLUDED_ENV.test(k)),
  ) as Record<string, string>;
  const registry = registryFrom(new FsDefinitionSource(ctx.contentDir), 'fs');
  const now = ctx.now ?? (() => new Date());
  const outbound = createOutboundExecutor({
    config: {
      DATA_MODE: 'live',
      AF_SPO_TENANT_NAME: ctx.env.AF_SPO_TENANT_NAME,
      OUTBOUND_CONCURRENCY: 4,
      OUTBOUND_USER_CONCURRENCY: 4,
      OUTBOUND_TIMEOUT_MS: 60_000,
      TOKEN_CACHE_KEY: undefined,
    },
    broker: null,
    auth: null,
    automation: { clientId: 'automation', credential: 'secret', token: (scope) => automation.token(scope) },
    fetch: recorder,
    connection: async (key) => (await registry.resolve('connection', key)).def,
    env: () => env,
    now,
  });
  const runner = new DatasourceRunner({ definitions: registry, outbound, env: () => env, now });
  const user = { oid: 'automation', upn: 'automation', name: 'Automation identity', roles: [] };
  let ok = true;
  try {
    const page = await runner.page(pageKey);
    const names = opts.datasource ? [opts.datasource] : Object.keys(page.def.datasources ?? {});
    const values = await runner.prepareParams(page, params, user);
    for (const name of names) {
      const ds = runner.datasource(page, name);
      if (ds.source === 'static' || ds.source === 'runner') {
        ctx.out(`· ${name}: ${ds.source} datasource, nothing to record.`);
        continue;
      }
      const before = recorded.length;
      try {
        await runner.run({
          identity: { kind: 'automation', mode: 'read' },
          user,
          page,
          datasource: name,
          params: values,
          correlationId: randomUUID(),
          noCache: true,
        });
        ctx.out(`✓ ${name}: ${recorded.length - before} response(s) recorded.`);
      } catch (err) {
        const e = err as { code?: string; status?: number; message?: string };
        ctx.out(
          `✗ ${name}: ${e.status ?? ''} ${e.code ?? 'error'} (responses recorded so far are still written)`,
        );
        ok = false;
      }
    }
  } finally {
    await registry.close();
  }

  const items = recorded.flatMap(expand);
  const sanitizer = new Sanitizer({
    forbidden: forbiddenValues(ctx.env),
    domains: [ctx.env.AF_PRIMARY_DOMAIN ?? ''].filter(Boolean),
    keepGuids: KEEP_GUIDS,
  });
  for (const it of items) {
    sanitizer.collectUrl(it.url);
    sanitizer.collect(it.body, kindFromPath(new URL(it.url).pathname));
  }
  let written = 0;
  for (const it of items) {
    const url = sanitizer.url(it.url);
    const body = sanitizer.apply(it.body);
    const content =
      it.status >= 200 && it.status < 300 && body !== undefined
        ? body
        : { $fixture: { status: it.status, ...(body !== undefined ? { body } : {}) } };
    const text = `${JSON.stringify(content, null, 2)}\n`;
    const leaks = sanitizer.leaks(`${url}\n${text}`);
    const key = fixtureKey(it.method, url);
    const specific = key.candidates[0]!;
    if (leaks.length) {
      ctx.out(
        `✗ refused ${specific}: it would still contain ${leaks.length} value(s) from the local env file.`,
      );
      ok = false;
      continue;
    }
    const targets = [...new Set([specific, key.candidates.at(-1)!])];
    for (const [i, relPath] of targets.entries()) {
      const file = path.join(ctx.fixturesDir, relPath);
      const exists = existsSync(file);
      // The generic fallback (<METHOD>.json) is only created, never overwritten.
      if (exists && (i > 0 || !opts.force)) {
        if (i === 0)
          ctx.out(
            `· kept ${rel(ctx, file)} (exists; --force overwrites${relPath.endsWith('/POST.json') ? '; POST fixtures are shared — add a variant by hand' : ''})`,
          );
        continue;
      }
      if (opts.dryRun) ctx.out(`· would write ${rel(ctx, file)}`);
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
        ctx.out(`✓ wrote ${rel(ctx, file)}`);
        written++;
      }
    }
  }
  ctx.out(
    `${ok ? '✓' : '⚠'} ${items.length} response(s) sanitized, ${written} file(s) ${opts.dryRun ? 'not written (dry run)' : 'written'}.`,
  );
  return ok;
}
