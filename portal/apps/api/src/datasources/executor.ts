import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ApiError,
  evaluate,
  RESOURCE_GRAPH_API_VERSION,
  RESOURCE_GRAPH_PATH,
  type Mode,
  type Provenance,
} from '@adminforge/connectors';
import {
  collectExpressions,
  renderString,
  renderTemplate,
  splitTemplate,
  type Scope,
} from '@adminforge/expressions';
import type { Datasource, Kind, PageLike, Requires } from '@adminforge/schemas';
import { missingLicences, requiresBadge, type LicenceService } from '../capabilities/licences';
import type { DefinitionRegistry, ResolvedDefinition } from '../definitions/types';
import { AppError } from '../errors';
import { errorHint, outboundAppError, readableMessage } from '../execution/outbound';
import {
  identityCacheKey,
  identitySessionKey,
  type ExecutionIdentity,
  type OutboundExecutor,
  type ServiceCall,
} from '../execution/types';
import {
  AdvancedFilterError,
  advancedParamOf,
  compileAdvanced,
  dialectFor,
  parseAdvanced,
  rowsFilter,
  type AdvancedGroup,
} from './advanced';
import { cacheKey, Inflight, TtlCache } from './cache';
import { defaultTimespan, InvalidParams, resolveParams } from './params';
import { paramsUsed } from './used-params';

export const PAGE_KINDS = ['page', 'dashboard', 'report'] as const satisfies readonly Kind[];
export type PageKind = (typeof PAGE_KINDS)[number];

export interface LoadedPage extends ResolvedDefinition<PageLike> {
  kind: PageKind;
  key: string;
}

/** `user` in expression scope. */
export interface UserScope {
  oid: string;
  upn: string;
  name: string;
  roles: string[];
}

/** Error shape for partial failures (one datasource, one $batch sub-request). */
export interface ErrorInfo {
  code: string;
  message: string;
  hint?: string;
  /** `reauth`: where the browser signs in again (the app's own /auth/login, with any claims challenge). */
  login?: string;
}

export interface DatasourceOutput {
  data: unknown;
  /** Opaque cursor for the next page (paging: cursor). */
  cursor?: string;
  /** null for static and skipped datasources. */
  provenance: Provenance | null;
  /**
   * graphBatch: failed sub-requests (their value in `data` is null). `ds.<name>`: an `optional: true` datasource this
   * one uses (directly or further up the chain) failed, so it ran with `null` in its place — the result is incomplete.
   */
  errors?: Record<string, ErrorInfo>;
  /** `when` was false. */
  skipped?: true;
  /**
   * The data is part of the result: `paging: all` stopped at maxItems (or the page limit), or a `$batch` collection
   * answered with its first page only. Widgets say "showing the first N".
   */
  truncated?: true;
}

export interface RunInput {
  identity: ExecutionIdentity;
  user: UserScope;
  page: LoadedPage;
  datasource: string;
  /** Already validated with `prepareParams`. */
  params: Record<string, unknown>;
  cursor?: string;
  correlationId: string;
  signal?: AbortSignal;
  /** Exports: override the declared paging. */
  paging?: 'all' | { cursor?: string; pageSize?: number };
  maxItems?: number;
  /** Skip the cache (exports). */
  noCache?: boolean;
  /** Results of the datasources this one references as `ds.<name>` (resolved automatically when omitted). */
  deps?: Record<string, unknown>;
  /** With `deps`: failures of `optional` dependencies behind them (`ds.<name>` → error), recorded in `errors`. */
  depErrors?: Record<string, ErrorInfo>;
  /**
   * Longest this datasource may take, dependencies and every retry included (504 datasource_timeout after). Default:
   * DATASOURCE_DEADLINE_MS for a person's page load (delegated, declared paging); none for exports and schedules.
   * 0 = none.
   */
  deadlineMs?: number;
}

/** A PowerShell job for a `source: runner` datasource (always read mode). */
export interface RunnerJobSpec {
  script: string;
  sha256: string;
  parameters: Record<string, unknown>;
  services: string[];
  /** Clamped to ≤ 1800 s. */
  timeoutSeconds: number;
  mode: Mode;
}

/** Runs a datasource's script; `data` = the `data` of every `output` event, in order. */
export interface RunnerExec {
  run(
    identity: ExecutionIdentity,
    job: RunnerJobSpec,
    opts: { correlationId: string; signal?: AbortSignal },
  ): Promise<{ data: unknown[]; requestId?: string }>;
}

export const RUNNER_MAX_TIMEOUT_SECONDS = 1800;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/**
 * DATA_MODE=fixtures: `<dir>/runner/<script path>.json` holds the output data array, or
 * `{ "$fixture": { "variants": [{ "match": { "bodyIncludes": "…" | ["…"] }, "body": [...] }], "body": [...] } }` where every
 * `bodyIncludes` string must appear in the job parameters as compact JSON (case- and whitespace-insensitive).
 */
export function fixtureRunner(dir: string): RunnerExec {
  const root = path.resolve(dir, 'runner');
  return {
    async run(_identity, job) {
      const file = path.resolve(root, `${job.script}.json`);
      if (!file.startsWith(root + path.sep))
        throw new AppError(400, 'invalid_request', 'Invalid script path.');
      let content: unknown;
      try {
        content = JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError(404, 'upstream_not_found', `No runner fixture for ${job.script}.`, {
            hint: `Create runner/${job.script}.json in the fixtures directory.`,
          });
        throw new AppError(500, 'fixture_invalid', `The runner fixture for ${job.script} is not valid JSON.`);
      }
      let body = content;
      if (content && typeof content === 'object' && !Array.isArray(content) && '$fixture' in content) {
        const env = (
          content as {
            $fixture: {
              body?: unknown;
              variants?: Array<{ match?: { bodyIncludes?: string | string[] }; body?: unknown }>;
            };
          }
        ).$fixture;
        const text = norm(JSON.stringify(job.parameters ?? {}));
        const hit = (env.variants ?? []).find((v) =>
          [v.match?.bodyIncludes ?? []].flat().every((needle) => text.includes(norm(needle))),
        );
        body = hit ? hit.body : env.body;
      }
      return { data: Array.isArray(body) ? body : body === undefined || body === null ? [] : [body] };
    },
  };
}

export interface DatasourceDeps {
  definitions: DefinitionRegistry;
  outbound: OutboundExecutor;
  /** PowerShell datasources (fixture runner in DATA_MODE=fixtures; the runs worker's adapter live). */
  runner?: RunnerExec;
  licences?: LicenceService;
  env: () => Record<string, unknown>;
  now: () => Date;
  cache?: TtlCache<DatasourceOutput>;
  /** Byte cap of the default cache (DATASOURCE_CACHE_MAX_MB); default 256 MB. */
  cacheMaxBytes?: number;
  /** DATASOURCE_DEADLINE_MS: a person's page load stops after this long (0 = never). Default 120 s. */
  deadlineMs?: number;
  /** Suppressed failures of `optional` datasources are logged here (names and codes only). */
  log?: { warn(obj: object, msg: string): void };
}

/** 504 datasource_timeout: a person's page load ran past DATASOURCE_DEADLINE_MS. */
export const datasourceTimeout = (label: string | undefined, ms: number, filterable: boolean) =>
  new AppError(
    504,
    'datasource_timeout',
    `${label ?? 'This data'} took longer than ${Math.round(ms / 1000)} seconds to load, so AdminForge stopped loading it.`,
    {
      hint: filterable
        ? 'Narrow the filters (a shorter date range, a search or a facet) and try again.'
        : 'Try again in a few minutes. If it keeps happening, tell a Portal Admin which page it was.',
    },
  );

/** Raw (pre-transform) results kept after a transform failed, so trying again doesn't fetch everything again. */
const RAW_RETRY_TTL_SECONDS = 60;

/** The query builder's compiled filter, which counts as its param. */
const ADVANCED_REF = /\badvanced\b/;

const toErrorInfo = (err: unknown): ErrorInfo => {
  const e = outboundAppError(err);
  return {
    code: e.code,
    message: e.message,
    ...(e.extras.hint ? { hint: e.extras.hint } : {}),
    ...(e.code === 'reauth' && typeof e.extras.login === 'string' ? { login: e.extras.login } : {}),
  };
};
export { toErrorInfo };

type QueryValue = string | number | boolean;

/** Rendered query values → what a URL can carry (empty values dropped; arrays joined; objects as JSON). */
function cleanQuery(q: unknown): Record<string, QueryValue> | undefined {
  if (!q || typeof q !== 'object') return undefined;
  const out: Record<string, QueryValue> = {};
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] =
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        ? v
        : Array.isArray(v)
          ? v.join(',')
          : JSON.stringify(v);
  }
  return out;
}

function cleanHeaders(h: unknown): Record<string, string> | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>))
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

/** `/users/${ $encode($guid(params.id)) }/memberOf` → `/users/{id}/memberOf` (provenance without values). */
export function pathTemplateOf(path: string): string {
  try {
    return splitTemplate(path)
      .map((s) => {
        if (s.type === 'text') return s.value;
        const name = /\b(?:params|inputs|row|item|user|env)\.([A-Za-z_][A-Za-z0-9_]*)/.exec(s.source)?.[1];
        return `{${name ?? 'value'}}`;
      })
      .join('');
  } catch {
    return path;
  }
}

const DS_REF = /\bds\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * `dependency_failed` (424). Keeps the dependency's own error as `cause`, so `optional` can see what really failed.
 * The person sees what really failed — its message, hint and, for a sign-in problem, the sign-in link — never the
 * internal datasource names (`datasource`, `dependency` stay on the error for logs).
 */
export class DependencyFailed extends AppError {
  constructor(
    readonly datasource: string,
    readonly dependency: string,
    readonly cause: unknown,
  ) {
    const info = toErrorInfo(cause);
    super(424, 'dependency_failed', info.message, {
      ...(info.hint ? { hint: info.hint } : {}),
      ...(info.login ? { login: info.login } : {}),
    });
    this.name = 'DependencyFailed';
  }
}

/**
 * Failures `optional: true` never turns into `null`: the person (or, for schedules, the operator) has to see them —
 * a missing portal role, the request policy, a missing tenant licence, or a sign-in / arming problem.
 */
const NEVER_OPTIONAL: ReadonlySet<string> = new Set([
  'forbidden',
  'policy_denied',
  'licence_required',
  'not_armed',
  'rearm',
  'reauth',
]);

/** The first error in a `dependency_failed` chain that must not be swallowed, if any (checked down to the root). */
export function blockingCause(err: unknown): AppError | undefined {
  for (let e: unknown = err, depth = 0; depth < 64; depth++) {
    if (e instanceof DependencyFailed) {
      e = e.cause;
      continue;
    }
    const mapped = outboundAppError(e);
    return NEVER_OPTIONAL.has(mapped.code) ? mapped : undefined;
  }
  return outboundAppError(err); // an absurdly deep chain is never treated as optional
}

/** Suppressed dependency failures (`ds.<name>` keys of `errors`), e.g. for exports and scheduled reports. */
export function dependencyErrors(out: Pick<DatasourceOutput, 'errors'>): Record<string, ErrorInfo> {
  return Object.fromEntries(Object.entries(out.errors ?? {}).filter(([k]) => k.startsWith('ds.')));
}

/** Tiny counting semaphore (execute-many concurrency). */
function limiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const merge = (a?: Requires, b?: Requires): Requires | undefined =>
  !a
    ? b
    : !b
      ? a
      : {
          ...a,
          ...b,
          licences: [...(a.licences ?? []), ...(b.licences ?? [])],
          entraRoles: [...(a.entraRoles ?? []), ...(b.entraRoles ?? [])],
          scopes: { ...a.scopes, ...b.scopes },
        };

/**
 * Executes a page's declared datasources (§4.3): requests are rendered from the *published* definition only (the
 * client sends a page key, datasource name and params — never a URL), params are validated against the declaration,
 * calls go through the outbound executor (policy, tokens, provenance), `transform` is applied, and results are cached
 * per user + mode + datasource + params for `cache.ttl` seconds.
 */
export class DatasourceRunner {
  readonly cache: TtlCache<DatasourceOutput>;
  private readonly depCache = new Map<string, string[]>();
  private readonly paramRefCache = new Map<string, string[] | '*'>();
  /** Identical concurrent executions (same user, session and key) share one (§ enterprise scale). */
  private readonly inflight = new Inflight<DatasourceOutput>();
  /** Raw results whose transform failed (see RAW_RETRY_TTL_SECONDS). */
  private readonly rawCache: TtlCache<DatasourceOutput>;

  constructor(private readonly deps: DatasourceDeps) {
    this.cache = deps.cache ?? new TtlCache<DatasourceOutput>(1000, deps.now, deps.cacheMaxBytes);
    this.rawCache = new TtlCache<DatasourceOutput>(
      100,
      deps.now,
      Math.round((deps.cacheMaxBytes ?? 256 * 1024 * 1024) / 4),
    );
    deps.definitions.onChange((change) => {
      this.depCache.clear();
      this.paramRefCache.clear();
      // A changed page, dashboard or report drops only its own results; anything else (a connection, `all`) drops all.
      const keys = change?.keys;
      if (
        change?.all ||
        !keys?.length ||
        keys.some((k) => !PAGE_KINDS.some((kind) => k.startsWith(`${kind}:`)))
      ) {
        this.cache.clear();
        this.rawCache.clear();
        return;
      }
      for (const k of keys) {
        this.cache.deleteTag(k);
        this.rawCache.deleteTag(k);
      }
    });
  }

  async page(key: string, version?: string): Promise<LoadedPage> {
    const r = await this.deps.definitions.resolveAny(PAGE_KINDS, key, version);
    return { def: r.def as PageLike, version: r.version, sha256: r.sha256, kind: r.kind, key };
  }

  /** Portal roles: every role in `requires.portalRoles` (the same rule as runs and scheduled data). */
  assertAccess(roles: string[], requires: Requires | undefined, what: string): void {
    const missing = (requires?.portalRoles ?? []).filter((r) => !roles.includes(r));
    // (kept free of Fastify imports: the CLI runs this code too)
    if (missing.length)
      throw new AppError(403, 'forbidden', `${what} needs the ${missing.join(' and ')} role.`, {
        hint: `Ask a portal administrator to add you to the matching AdminForge group (SG-AdminForge-…-${missing[0]}).`,
      });
  }

  scope(user: UserScope, params: Record<string, unknown>): Scope & { now: string } {
    return { params, user, env: this.deps.env(), now: this.deps.now().toISOString() };
  }

  /**
   * Expression scope for one datasource. The query builder's validated filter is removed from `params` and offered
   * only compiled for this datasource's dialect as `advanced` (OData for Graph, KQL for Resource Graph/Log Analytics),
   * or — on `dialect: rows` pages — as validated data for `$applyAdvanced(rows, advanced)` in a transform.
   */
  private datasourceScope(
    page: LoadedPage,
    ds: Datasource,
    user: UserScope,
    params: Record<string, unknown>,
    deps: Record<string, unknown>,
  ): Scope & { now: string } {
    const name = advancedParamOf(page.def.filters);
    if (!name) return { ...this.scope(user, params), ds: deps };
    const { [name]: filter, ...plain } = params;
    const pageDialect = page.def.filters?.advanced?.dialect;
    if (pageDialect === 'rows')
      return {
        ...this.scope(user, plain),
        ds: deps,
        advanced: filter ? rowsFilter(filter as AdvancedGroup) : undefined,
      };
    const dialect = pageDialect === 'client' ? undefined : dialectFor(ds.source);
    const advanced = filter && dialect ? compileAdvanced(filter as AdvancedGroup, dialect) : undefined;
    return { ...this.scope(user, plain), ds: deps, advanced };
  }

  /** Params minus the query builder's filter (file names, audit summaries). */
  publicParams(page: LoadedPage, params: Record<string, unknown>): Record<string, unknown> {
    const name = advancedParamOf(page.def.filters);
    if (!name || !(name in params)) return params;
    const { [name]: _f, ...plain } = params;
    return plain;
  }

  /**
   * Validates and defaults params for a page. Throws InvalidParams (400). The query builder's filter (request param
   * `filters.advanced.param`, default `adv`) is validated against the declared fields and kept as structured data.
   */
  async prepareParams(
    page: LoadedPage,
    raw: Record<string, unknown> | undefined,
    user: UserScope,
  ): Promise<Record<string, unknown>> {
    const name = advancedParamOf(page.def.filters);
    const now = this.deps.now();
    let rest = raw;
    let filter: AdvancedGroup | undefined;
    if (name && raw && Object.hasOwn(raw, name)) {
      const { [name]: rawFilter, ...others } = raw;
      rest = others;
      if (page.def.filters!.advanced!.dialect !== 'client') {
        try {
          filter = parseAdvanced(page.def.filters!.advanced!, rawFilter, now);
        } catch (err) {
          if (err instanceof AdvancedFilterError) throw new InvalidParams(err.issues);
          throw err;
        }
      }
    }
    const values = await resolveParams(page.def.params, rest, {
      user,
      env: this.deps.env(),
      now: now.toISOString(),
    });
    return filter && name ? { ...values, [name]: filter } : values;
  }

  datasource(page: LoadedPage, name: string): Datasource {
    const ds = Object.hasOwn(page.def.datasources ?? {}, name) ? page.def.datasources![name] : undefined;
    if (!ds)
      throw new AppError(
        404,
        'datasource_not_found',
        `${page.kind} "${page.key}" has no datasource "${name}".`,
      );
    return ds;
  }

  /** `ds.<name>` references of one datasource (request, `when`, `transform`) that name another datasource of the page. */
  private directRefs(page: LoadedPage, name: string): string[] {
    const all = page.def.datasources ?? {};
    const refs = new Set<string>();
    for (const e of collectExpressions(this.datasource(page, name)))
      for (const m of e.source.matchAll(DS_REF)) if (Object.hasOwn(all, m[1]!)) refs.add(m[1]!);
    return [...refs];
  }

  /**
   * Datasources this one references as `ds.<name>` in its request, `when` or `transform` (they run first).
   *
   * The order comes from the references, not from the order of the keys in `datasources`: published definitions are
   * stored in Postgres, which doesn't keep object key order, so "declared above" can't be trusted at run time. Authors
   * still declare dependencies first (`adminforge validate` checks that in the file); here a cycle — including a
   * datasource that references itself — is the only content error.
   */
  dependencies(page: LoadedPage, name: string): string[] {
    const memoKey = `${page.kind}:${page.key}:${page.sha256}:${name}`;
    const hit = this.depCache.get(memoKey);
    if (hit) return hit;
    // Depth-first walk from `name`: meeting a datasource that is still on the path is a cycle.
    const path: string[] = [];
    const done = new Set<string>();
    const visit = (n: string) => {
      if (done.has(n)) return;
      const at = path.indexOf(n);
      if (at >= 0)
        throw new AppError(
          500,
          'content_error',
          `Datasources reference each other in a loop: ${[...path.slice(at), n].map((d) => `ds.${d}`).join(' → ')}.`,
          { hint: 'A datasource can only use results of datasources that don’t depend on it.' },
        );
      path.push(n);
      for (const ref of this.directRefs(page, n)) visit(ref);
      path.pop();
      done.add(n);
    };
    visit(name);
    const order = Object.keys(page.def.datasources ?? {});
    const deps = this.directRefs(page, name).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    this.depCache.set(memoKey, deps);
    return deps;
  }

  /**
   * Several datasources of one page (execute-many): independent ones in parallel (≤ `concurrency`), each dependent
   * after the datasources it references. Failures are per datasource; a dependent of a failed one fails with
   * `dependency_failed` (or, for an `optional` one, runs without it — see `suppress`). Results come back in the order
   * asked.
   */
  async runMany(
    base: Omit<RunInput, 'datasource' | 'cursor' | 'paging' | 'maxItems' | 'deps'>,
    names: readonly string[],
    concurrency = 6,
  ): Promise<Record<string, DatasourceOutput | { error: ErrorInfo }>> {
    const limit = limiter(concurrency);
    const memo = new Map<string, Promise<DatasourceOutput>>();
    const exec = (name: string): Promise<DatasourceOutput> => {
      let p = memo.get(name);
      if (!p) {
        p = (async () => {
          const deps: Record<string, unknown> = {};
          const depErrors: Record<string, ErrorInfo> = {};
          for (const d of this.dependencies(base.page, name)) {
            base.signal?.throwIfAborted();
            try {
              const out = await exec(d);
              deps[d] = out.data;
              Object.assign(depErrors, dependencyErrors(out));
            } catch (err) {
              deps[d] = this.suppress({ ...base, datasource: name }, d, err, depErrors);
            }
          }
          // A page left (or out of time) while it waited for a turn doesn't start its remaining datasources.
          base.signal?.throwIfAborted();
          return limit(() => {
            base.signal?.throwIfAborted();
            return this.run({ ...base, datasource: name, deps, depErrors });
          });
        })();
        p.catch(() => undefined);
        memo.set(name, p);
      }
      return p;
    };
    const unique = [...new Set(names)];
    const settled = await Promise.all(
      unique.map(async (name): Promise<[string, DatasourceOutput | { error: ErrorInfo }]> => {
        try {
          return [name, await exec(name)];
        } catch (err) {
          return [name, { error: toErrorInfo(err) }];
        }
      }),
    );
    return Object.fromEntries(settled);
  }

  private async resolveDeps(
    input: RunInput,
    names: string[],
  ): Promise<{ values: Record<string, unknown>; errors: Record<string, ErrorInfo> }> {
    const values: Record<string, unknown> = {};
    const errors: Record<string, ErrorInfo> = {};
    for (const dep of names) {
      input.signal?.throwIfAborted();
      try {
        const out = await this.run({
          ...input,
          datasource: dep,
          cursor: undefined,
          paging: undefined,
          maxItems: undefined,
          deps: undefined,
          depErrors: undefined,
        });
        values[dep] = out.data;
        Object.assign(errors, dependencyErrors(out));
      } catch (err) {
        values[dep] = this.suppress(input, dep, err, errors);
      }
    }
    return { values, errors };
  }

  /**
   * A dependency failed. `optional: true`: the dependent sees `null` in its place, and the failure is recorded in the
   * dependent's `errors` (`ds.<name>`) and logged, so the result is visibly incomplete. Never for failures the person
   * has to see (NEVER_OPTIONAL — a missing portal role, the request policy, a missing licence, sign-in or arming)
   * anywhere in the chain behind it: those fail the dependent with `dependency_failed`.
   */
  private suppress(
    input: Pick<RunInput, 'page' | 'datasource' | 'correlationId' | 'signal'>,
    dep: string,
    err: unknown,
    into: Record<string, ErrorInfo>,
  ): null {
    // A closed page or a spent deadline is never an optional failure: it ends the whole load.
    if (input.signal?.aborted) throw input.signal.reason ?? err;
    if (this.datasource(input.page, dep).optional !== true || blockingCause(err))
      throw new DependencyFailed(input.datasource, dep, err);
    const info = toErrorInfo(err);
    into[`ds.${dep}`] = info;
    this.deps.log?.warn(
      {
        page: `${input.page.kind}:${input.page.key}`,
        datasource: input.datasource,
        dependency: dep,
        code: info.code,
        correlationId: input.correlationId,
      },
      'optional datasource failed; its dependents ran without it',
    );
    return null;
  }

  /**
   * Runs one datasource. A person's page load (delegated identity, declared paging) gets the deadline
   * (DATASOURCE_DEADLINE_MS); identical concurrent executions are shared; results are cached for `cache.ttl` seconds
   * per user + mode + page version + datasource + the params it uses + its dependencies (by their own keys).
   */
  async run(input: RunInput): Promise<DatasourceOutput> {
    const ms =
      input.deadlineMs ??
      (input.identity.kind === 'delegated' && input.paging === undefined
        ? (this.deps.deadlineMs ?? 120_000)
        : 0);
    if (!ms) return this.runOnce({ ...input, deadlineMs: 0 });
    const timer = AbortSignal.timeout(ms);
    const signal = input.signal ? AbortSignal.any([input.signal, timer]) : timer;
    try {
      // Dependencies run inside this deadline, not with one of their own.
      return await this.runOnce({ ...input, signal, deadlineMs: 0 });
    } catch (err) {
      if (timer.aborted && !input.signal?.aborted) {
        const ds = this.datasource(input.page, input.datasource);
        const def = input.page.def;
        const filterable = Object.keys(def.params ?? {}).length > 0 || !!def.filters;
        throw datasourceTimeout((ds as { label?: string }).label, ms, filterable);
      }
      throw err;
    }
  }

  private async runOnce(input: RunInput): Promise<DatasourceOutput> {
    const { page, user } = input;
    const ds = this.datasource(page, input.datasource);
    // Roles of the whole chain first: a cached result built from a datasource the person may no longer read is
    // never served (the cache is per user, but roles change).
    if (ds.requires?.portalRoles)
      this.assertAccess(user.roles, ds.requires, `Datasource ${input.datasource}`);
    for (const name of this.chain(page, input.datasource)) {
      const r = this.datasource(page, name).requires;
      try {
        if (r?.portalRoles) this.assertAccess(user.roles, r, `Datasource ${name}`);
      } catch (err) {
        // The same answer as when the dependency runs and is refused (never hidden by `optional`).
        throw new DependencyFailed(input.datasource, name, err);
      }
    }

    const paging =
      input.paging ??
      ('paging' in ds ? (ds.paging === 'cursor' ? { cursor: input.cursor } : ds.paging) : undefined);
    const ttl = input.noCache ? 0 : (ds.cache?.ttl ?? 0);
    // Exports (noCache) neither read nor share: they run on their own.
    const key = input.noCache ? '' : this.keyFor(input, input.datasource, paging, input.maxItems);
    if (ttl) {
      const hit = this.cache.get(key);
      if (hit)
        return {
          ...hit.value,
          provenance: hit.value.provenance
            ? { ...hit.value.provenance, cachedAt: hit.cachedAt.toISOString() }
            : null,
        };
    }
    if (!key) return this.execute(input, ds, paging, '', 0);
    const who = identitySessionKey(input.identity);
    return this.inflight.run(`${who}|${key}`, input.signal, (signal) =>
      this.execute({ ...input, signal }, ds, paging, key, ttl),
    );
  }

  /** The work behind `run`: dependencies, `when`, licences, the call, the transform, the cache. */
  private async execute(
    input: RunInput,
    ds: Datasource,
    paging: unknown,
    key: string,
    ttl: number,
  ): Promise<DatasourceOutput> {
    const { page, user } = input;
    const requires = merge(page.def.requires, ds.requires);
    const depNames = this.dependencies(page, input.datasource);
    const resolved = !depNames.length
      ? { values: {}, errors: {} }
      : input.deps
        ? { values: input.deps, errors: input.depErrors ?? {} }
        : await this.resolveDeps(input, depNames);
    const depValues: Record<string, unknown> = resolved.values;
    const incomplete = Object.keys(resolved.errors).length ? resolved.errors : undefined;
    const scope = this.datasourceScope(page, ds, user, input.params, depValues);

    if (ds.when !== undefined) {
      const ok =
        typeof ds.when === 'boolean'
          ? ds.when
          : await this.expr(() => renderString(ds.when as string, scope), 'when');
      if (ok !== true)
        return { data: null, provenance: null, skipped: true, ...(incomplete ? { errors: incomplete } : {}) };
    }

    if (requires?.licences?.length && this.deps.licences) {
      const missing = missingLicences(
        await this.deps.licences.get(input.identity, { correlationId: input.correlationId }),
        requires.licences,
      );
      if (missing?.length)
        throw new AppError(403, 'licence_required', `${requiresBadge(missing)}.`, {
          hint: 'The tenant has no subscription that includes this; ask your licensing admin.',
        });
    }

    const tag = `${page.kind}:${page.key}`;
    // A transform that failed a moment ago (timeout under load) is tried again on the data already fetched.
    // Only for cached datasources (ttl > 0): an uncached one must always show fresh data.
    const raw = key && ttl && ds.transform && !incomplete ? this.rawCache.get(key) : undefined;
    let out: DatasourceOutput;
    if (raw) {
      out = { ...raw.value };
      this.rawCache.delete(key);
    } else if (ds.source === 'static') {
      out = { data: await this.expr(() => renderTemplate(ds.data, scope), 'data'), provenance: null };
    } else if (ds.source === 'runner') {
      out = await this.runScript(ds, input, scope);
    } else {
      const call = await this.buildCall(ds, page, input, scope, requires);
      call.paging =
        ds.source === 'graphBatch' || ds.source === 'logAnalytics' || ds.source === 'function'
          ? undefined
          : (paging as ServiceCall['paging']);
      if (input.maxItems ?? ('maxItems' in ds ? ds.maxItems : undefined))
        call.maxItems = input.maxItems ?? (ds as { maxItems?: number }).maxItems;
      const res = await this.deps.outbound.execute(input.identity, call, {
        correlationId: input.correlationId,
        signal: input.signal,
      });
      out = {
        data: res.data,
        provenance: res.provenance,
        ...(res.nextCursor ? { cursor: res.nextCursor } : {}),
        ...(res.truncated ? { truncated: true as const } : {}),
      };
      if (ds.source === 'graphBatch')
        Object.assign(out, this.batchResult(res.data, input.identity, requires));
    }

    if (ds.transform) {
      const value = out.data;
      try {
        out.data = await this.expr(() => renderString(ds.transform!, { ...scope, value }), 'transform');
      } catch (err) {
        // Kept no longer than the datasource's own cache, and only once: a raw result that failed again goes.
        if (key && ttl && !incomplete && !raw)
          this.rawCache.set(key, { ...out, data: value }, Math.min(ttl, RAW_RETRY_TTL_SECONDS), { tag });
        throw err;
      }
    }
    if (incomplete) out.errors = { ...out.errors, ...incomplete };
    // Results missing an optional dependency aren't kept: the next load may have it.
    else if (ttl) this.cache.set(key, out, ttl, { tag });
    return out;
  }

  /**
   * Cache (and sharing) key of a datasource without running anything: its dependencies count by their own keys, not
   * their values, and only the params its expressions use count (all of them when that can't be told).
   */
  private keyFor(
    input: RunInput,
    name: string,
    paging: unknown,
    maxItems: number | undefined,
    memo = new Map<string, string>(),
  ): string {
    const { page } = input;
    const deps = this.dependencies(page, name);
    return cacheKey([
      identityCacheKey(input.identity),
      input.identity.mode,
      page.kind,
      page.key,
      page.sha256,
      name,
      this.usedParams(page, name, input.params),
      paging ?? null,
      maxItems ?? null,
      deps.length
        ? deps.map((d) => {
            let k = memo.get(d);
            if (k === undefined) {
              const dep = this.datasource(page, d);
              const declared =
                'paging' in dep ? (dep.paging === 'cursor' ? { cursor: undefined } : dep.paging) : undefined;
              k = this.keyFor(input, d, declared, undefined, memo);
              memo.set(d, k);
            }
            return [d, k];
          })
        : null,
    ]);
  }

  /** Every datasource `name` depends on, directly or further up the chain (no duplicates). */
  private chain(page: LoadedPage, name: string): string[] {
    const out = new Set<string>();
    const walk = (n: string) => {
      for (const d of this.dependencies(page, n))
        if (!out.has(d)) {
          out.add(d);
          walk(d);
        }
    };
    walk(name);
    return [...out];
  }

  /** The params a datasource's expressions reference (the query builder's filter as `advanced`). */
  private usedParams(
    page: LoadedPage,
    name: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const memoKey = `${page.kind}:${page.key}:${page.sha256}:${name}`;
    let refs = this.paramRefCache.get(memoKey);
    if (refs === undefined) {
      refs = this.paramRefs(page, name);
      this.paramRefCache.set(memoKey, refs);
    }
    if (refs === '*') return params;
    return Object.fromEntries(refs.filter((n) => Object.hasOwn(params, n)).map((n) => [n, params[n]]));
  }

  private paramRefs(page: LoadedPage, name: string): string[] | '*' {
    const ds = this.datasource(page, name);
    // Log Analytics without its own timespan takes the page's timespan param implicitly.
    if (ds.source === 'logAnalytics' && !ds.timespan) return '*';
    const advanced = advancedParamOf(page.def.filters);
    const names = new Set<string>();
    for (const e of collectExpressions(ds)) {
      // `params.<name>` only; root, `$$`, wildcard or indexed access means all of them (used-params.ts).
      const used = paramsUsed(e.source);
      if (used === '*') return '*';
      for (const n of used) names.add(n);
      if (advanced && ADVANCED_REF.test(e.source)) names.add(advanced);
    }
    return [...names].sort();
  }

  private async expr<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        500,
        'content_error',
        `The datasource ${what} expression failed: ${(err as Error).message}`,
        { hint: 'Fix the definition (adminforge validate) and publish it again.' },
      );
    }
  }

  /** `source: runner`: read-mode PowerShell job; result = every `output` event's data, in order. */
  private async runScript(
    ds: Extract<Datasource, { source: 'runner' }>,
    input: RunInput,
    scope: Scope,
  ): Promise<DatasourceOutput> {
    const runner = this.deps.runner;
    if (!runner)
      throw new AppError(503, 'runner_not_configured', 'PowerShell datasources need the runner.', {
        hint: 'Set RUNNER_URL and RUNNER_SHARED_KEY in the env file (or use DATA_MODE=fixtures).',
      });
    // Datasources only read: the runner loads Get-* cmdlets only in read mode (§5.4).
    const decision = evaluate('read', { service: 'runner', method: 'POST', path: '/v1/jobs' });
    if (!decision.allowed) throw new AppError(403, 'policy_denied', decision.reason);
    const parameters =
      (await this.expr(
        () => renderTemplate<Record<string, unknown>>(ds.parameters ?? {}, scope),
        'parameters',
      )) ?? {};
    const started = performance.now();
    // The runner signs in with forwarded delegated tokens or as the automation identity; a schedule's grant and a
    // named app identity can't reach it yet.
    if (input.identity.kind === 'grant' || (input.identity.kind === 'automation' && input.identity.app))
      throw new AppError(
        501,
        'runner_identity_not_supported',
        'PowerShell data sources can only run as you or as the automation identity, not as this schedule’s identity.',
        { hint: 'Run this schedule as the automation identity, or use a report without PowerShell data.' },
      );
    const identity: ExecutionIdentity =
      input.identity.kind === 'automation'
        ? { kind: 'automation', mode: 'read' }
        : { ...input.identity, mode: 'read' };
    const res = await runner.run(
      identity,
      {
        script: ds.script,
        sha256: ds.sha256,
        parameters,
        services: ds.services ?? [],
        timeoutSeconds: Math.min(ds.timeoutSeconds ?? 300, RUNNER_MAX_TIMEOUT_SECONDS),
        mode: 'read',
      },
      { correlationId: input.correlationId, signal: input.signal },
    );
    return {
      data: res.data,
      provenance: {
        service: 'runner',
        path: ds.script,
        ms: Math.round(performance.now() - started),
        ...(res.requestId ? { requestId: res.requestId } : {}),
      },
    };
  }

  private batchResult(
    data: unknown,
    identity: ExecutionIdentity,
    requires: Requires | undefined,
  ): Pick<DatasourceOutput, 'data' | 'errors'> {
    const responses =
      (data as { responses?: Array<{ id: string; status: number; body: unknown }> } | undefined)?.responses ??
      [];
    const values: Record<string, unknown> = {};
    const errors: Record<string, ErrorInfo> = {};
    for (const r of responses) {
      if (r.status >= 200 && r.status < 300) values[r.id] = r.body ?? null;
      else {
        values[r.id] = null;
        const e = (r.body as { error?: { code?: string; message?: string } } | undefined)?.error;
        const apiErr = new ApiError(
          r.status,
          e?.code ?? `HTTP${r.status}`,
          e?.message ?? `Microsoft Graph returned ${r.status}.`,
        );
        const mapped = errorHint(apiErr, 'graph', identity, requires);
        errors[r.id] = {
          code: mapped.licence ? 'licence_required' : apiErr.code,
          // Written text, never Microsoft's raw JSON (the usage reports nest a whole error body in `message`).
          message: mapped.message ?? readableMessage(apiErr.message),
          hint: mapped.hint,
        };
      }
    }
    return { data: values, ...(Object.keys(errors).length ? { errors } : {}) };
  }

  private async buildCall(
    ds: Exclude<Datasource, { source: 'static' }>,
    page: LoadedPage,
    input: RunInput,
    scope: Scope,
    requires: Requires | undefined,
  ): Promise<ServiceCall> {
    const render = <T>(v: unknown, what: string) => this.expr(() => renderTemplate<T>(v, scope), what);
    const base = { requires };
    switch (ds.source) {
      case 'graph': {
        const r = await render<{
          method?: string;
          path: string;
          query?: unknown;
          headers?: unknown;
          body?: unknown;
          beta?: boolean;
        }>(ds.request, 'request');
        return {
          ...base,
          service: 'graph',
          method: r.method ?? 'GET',
          path: String(r.path),
          query: cleanQuery(r.query),
          headers: cleanHeaders(r.headers),
          body: r.body,
          beta: r.beta,
          pathTemplate: pathTemplateOf(ds.request.path),
        };
      }
      case 'graphBatch': {
        const reqs = await render<
          Record<
            string,
            {
              method?: string;
              path: string;
              query?: unknown;
              headers?: unknown;
              body?: unknown;
              beta?: boolean;
            }
          >
        >(ds.requests, 'requests');
        const requests = Object.entries(reqs).map(([id, r]) => ({
          id,
          method: r.method ?? 'GET',
          path: String(r.path),
          query: cleanQuery(r.query),
          headers: cleanHeaders(r.headers),
          body: r.body,
          beta: r.beta,
        }));
        return {
          ...base,
          service: 'graph',
          method: 'POST',
          path: '/$batch',
          body: { requests },
          pathTemplate: '/$batch',
        };
      }
      case 'arm': {
        const r = await render<{
          method?: string;
          path: string;
          apiVersion: string;
          query?: unknown;
          headers?: unknown;
          body?: unknown;
        }>(ds.request, 'request');
        return {
          ...base,
          service: 'arm',
          method: r.method ?? 'GET',
          path: String(r.path),
          apiVersion: r.apiVersion,
          query: cleanQuery(r.query),
          headers: cleanHeaders(r.headers),
          body: r.body,
          pathTemplate: pathTemplateOf(ds.request.path),
        };
      }
      case 'resourceGraph': {
        const query = await render<string>(ds.query, 'query');
        const subscriptions =
          ds.subscriptions === undefined
            ? undefined
            : await render<unknown>(ds.subscriptions, 'subscriptions');
        const managementGroups =
          ds.managementGroups === undefined
            ? undefined
            : await render<unknown>(ds.managementGroups, 'managementGroups');
        const list = (v: unknown) =>
          Array.isArray(v)
            ? v.filter((s): s is string => typeof s === 'string' && !!s)
            : typeof v === 'string' && v
              ? [v]
              : undefined;
        return {
          ...base,
          service: 'arm',
          method: 'POST',
          path: RESOURCE_GRAPH_PATH,
          apiVersion: RESOURCE_GRAPH_API_VERSION,
          body: {
            query: String(query),
            subscriptions: list(subscriptions),
            managementGroups: list(managementGroups),
          },
          pathTemplate: RESOURCE_GRAPH_PATH,
        };
      }
      case 'logAnalytics': {
        const workspace = String(await render<string>(ds.workspace, 'workspace'));
        const query = String(await render<string>(ds.query, 'query'));
        const timespan = ds.timespan
          ? String(await render<string>(ds.timespan, 'timespan'))
          : (defaultTimespan(page.def.params, input.params) ?? 'P1D');
        return {
          ...base,
          service: 'logAnalytics',
          method: 'POST',
          path: `/v1/workspaces/${encodeURIComponent(workspace)}/query`,
          body: { query, timespan },
          pathTemplate: '/v1/workspaces/{workspace}/query',
        };
      }
      case 'function': {
        const r = await render<{
          pathParams?: Record<string, unknown>;
          query?: unknown;
          headers?: unknown;
          body?: unknown;
        }>({ pathParams: ds.pathParams, query: ds.query, headers: ds.headers, body: ds.body }, 'request');
        return {
          ...base,
          service: 'function',
          method: 'GET',
          path: ds.operation,
          operation: ds.operation,
          connection: ds.connection,
          pathParams: r.pathParams,
          query: cleanQuery(r.query),
          headers: cleanHeaders(r.headers),
          body: r.body,
        };
      }
      case 'runner':
        throw new AppError(500, 'internal', 'Runner datasources do not use the outbound executor.');
    }
  }
}
