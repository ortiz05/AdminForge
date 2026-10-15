import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, evaluate, RESOURCE_GRAPH_API_VERSION, RESOURCE_GRAPH_PATH, type Mode, type Provenance } from '@adminforge/connectors';
import { collectExpressions, renderString, renderTemplate, splitTemplate, type Scope } from '@adminforge/expressions';
import type { Datasource, Kind, PageLike, Requires } from '@adminforge/schemas';
import { missingLicences, requiresBadge, type LicenceService } from '../capabilities/licences';
import type { DefinitionRegistry, ResolvedDefinition } from '../definitions/types';
import { AppError } from '../errors';
import { errorHint, outboundAppError } from '../execution/outbound';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '../execution/types';
import { AdvancedFilterError, advancedParamOf, compileAdvanced, dialectFor, parseAdvanced, type AdvancedGroup } from './advanced';
import { cacheKey, TtlCache } from './cache';
import { defaultTimespan, InvalidParams, resolveParams } from './params';

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
}

export interface DatasourceOutput {
  data: unknown;
  /** Opaque cursor for the next page (paging: cursor). */
  cursor?: string;
  /** null for static and skipped datasources. */
  provenance: Provenance | null;
  /** graphBatch: failed sub-requests (their value in `data` is null). */
  errors?: Record<string, ErrorInfo>;
  /** `when` was false. */
  skipped?: true;
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
  run(identity: ExecutionIdentity, job: RunnerJobSpec, opts: { correlationId: string; signal?: AbortSignal }): Promise<{ data: unknown[]; requestId?: string }>;
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
      if (!file.startsWith(root + path.sep)) throw new AppError(400, 'invalid_request', 'Invalid script path.');
      let content: unknown;
      try {
        content = JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError(404, 'upstream_not_found', `No runner fixture for ${job.script}.`, { hint: `Create runner/${job.script}.json in the fixtures directory.` });
        throw new AppError(500, 'fixture_invalid', `The runner fixture for ${job.script} is not valid JSON.`);
      }
      let body = content;
      if (content && typeof content === 'object' && !Array.isArray(content) && '$fixture' in content) {
        const env = (content as { $fixture: { body?: unknown; variants?: Array<{ match?: { bodyIncludes?: string | string[] }; body?: unknown }> } }).$fixture;
        const text = norm(JSON.stringify(job.parameters ?? {}));
        const hit = (env.variants ?? []).find((v) => [v.match?.bodyIncludes ?? []].flat().every((needle) => text.includes(norm(needle))));
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
}

const toErrorInfo = (err: unknown): ErrorInfo => {
  const e = outboundAppError(err);
  return { code: e.code, message: e.message, ...(e.extras.hint ? { hint: e.extras.hint } : {}) };
};
export { toErrorInfo };

type QueryValue = string | number | boolean;

/** Rendered query values → what a URL can carry (empty values dropped; arrays joined; objects as JSON). */
function cleanQuery(q: unknown): Record<string, QueryValue> | undefined {
  if (!q || typeof q !== 'object') return undefined;
  const out: Record<string, QueryValue> = {};
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : Array.isArray(v) ? v.join(',') : JSON.stringify(v);
  }
  return out;
}

function cleanHeaders(h: unknown): Record<string, string> | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
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

const dependencyFailed = (name: string, dep: string, err: unknown) => {
  const info = toErrorInfo(err);
  return new AppError(424, 'dependency_failed', `Datasource "${name}" needs "${dep}", which failed: ${info.message}`, info.hint ? { hint: info.hint } : {});
};

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
  !a ? b : !b ? a : { ...a, ...b, licences: [...(a.licences ?? []), ...(b.licences ?? [])], entraRoles: [...(a.entraRoles ?? []), ...(b.entraRoles ?? [])], scopes: { ...a.scopes, ...b.scopes } };

/**
 * Executes a page's declared datasources (§4.3): requests are rendered from the *published* definition only (the
 * client sends a page key, datasource name and params — never a URL), params are validated against the declaration,
 * calls go through the outbound executor (policy, tokens, provenance), `transform` is applied, and results are cached
 * per user + mode + datasource + params for `cache.ttl` seconds.
 */
export class DatasourceRunner {
  readonly cache: TtlCache<DatasourceOutput>;
  private readonly depCache = new Map<string, string[]>();

  constructor(private readonly deps: DatasourceDeps) {
    this.cache = deps.cache ?? new TtlCache<DatasourceOutput>(1000, deps.now);
    deps.definitions.onChange(() => {
      this.cache.clear();
      this.depCache.clear();
    });
  }

  async page(key: string, version?: string): Promise<LoadedPage> {
    const r = await this.deps.definitions.resolveAny(PAGE_KINDS, key, version);
    return { def: r.def as PageLike, version: r.version, sha256: r.sha256, kind: r.kind, key };
  }

  /** Portal roles (any of `requires.portalRoles`). */
  assertAccess(roles: string[], requires: Requires | undefined, what: string): void {
    const need = requires?.portalRoles;
    // (kept free of Fastify imports: the CLI runs this code too)
    if (need?.length && !need.some((r) => roles.includes(r)))
      throw new AppError(403, 'forbidden', `${what} needs one of the roles ${need.join(', ')}.`, { hint: 'Ask a portal administrator for access.' });
  }

  scope(user: UserScope, params: Record<string, unknown>): Scope & { now: string } {
    return { params, user, env: this.deps.env(), now: this.deps.now().toISOString() };
  }

  /**
   * Expression scope for one datasource. The query builder's validated filter is removed from `params` and offered
   * only compiled for this datasource's dialect as `advanced` (OData for Graph, KQL for Resource Graph/Log Analytics).
   */
  private datasourceScope(page: LoadedPage, ds: Datasource, user: UserScope, params: Record<string, unknown>, deps: Record<string, unknown>): Scope & { now: string } {
    const name = advancedParamOf(page.def.filters);
    if (!name) return { ...this.scope(user, params), ds: deps };
    const { [name]: filter, ...plain } = params;
    const dialect = page.def.filters?.advanced?.dialect === 'client' ? undefined : dialectFor(ds.source);
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
  async prepareParams(page: LoadedPage, raw: Record<string, unknown> | undefined, user: UserScope): Promise<Record<string, unknown>> {
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
    const values = await resolveParams(page.def.params, rest, { user, env: this.deps.env(), now: now.toISOString() });
    return filter && name ? { ...values, [name]: filter } : values;
  }

  datasource(page: LoadedPage, name: string): Datasource {
    const ds = Object.hasOwn(page.def.datasources ?? {}, name) ? page.def.datasources![name] : undefined;
    if (!ds) throw new AppError(404, 'datasource_not_found', `${page.kind} "${page.key}" has no datasource "${name}".`);
    return ds;
  }

  /**
   * Datasources this one references as `ds.<name>` in its request, `when` or `transform`. Only datasources declared
   * earlier may be referenced (they run first); anything else is a content error.
   */
  dependencies(page: LoadedPage, name: string): string[] {
    const memoKey = `${page.kind}:${page.key}:${page.sha256}:${name}`;
    const hit = this.depCache.get(memoKey);
    if (hit) return hit;
    const ds = this.datasource(page, name);
    const order = Object.keys(page.def.datasources ?? {});
    const self = order.indexOf(name);
    const refs = new Set<string>();
    for (const e of collectExpressions(ds)) for (const m of e.source.matchAll(DS_REF)) refs.add(m[1]!);
    const deps: string[] = [];
    for (const ref of refs) {
      const at = order.indexOf(ref);
      if (at < 0) continue;
      if (at >= self)
        throw new AppError(500, 'content_error', `Datasource "${name}" references ds.${ref}, which is not declared before it.`, { hint: 'Datasources can only use results of datasources declared above them.' });
      deps.push(ref);
    }
    deps.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    this.depCache.set(memoKey, deps);
    return deps;
  }

  /**
   * Several datasources of one page (execute-many): independent ones in parallel (≤ `concurrency`), each dependent
   * after the datasources it references. Failures are per datasource; a dependent of a failed one fails with
   * `dependency_failed`. Results come back in the order asked.
   */
  async runMany(base: Omit<RunInput, 'datasource' | 'cursor' | 'paging' | 'maxItems' | 'deps'>, names: readonly string[], concurrency = 6): Promise<Record<string, DatasourceOutput | { error: ErrorInfo }>> {
    const limit = limiter(concurrency);
    const memo = new Map<string, Promise<DatasourceOutput>>();
    const exec = (name: string): Promise<DatasourceOutput> => {
      let p = memo.get(name);
      if (!p) {
        p = (async () => {
          const deps: Record<string, unknown> = {};
          for (const d of this.dependencies(base.page, name)) {
            try {
              deps[d] = (await exec(d)).data;
            } catch (err) {
              throw dependencyFailed(name, d, err);
            }
          }
          return limit(() => this.run({ ...base, datasource: name, deps }));
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

  private async resolveDeps(input: RunInput, names: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const dep of names) {
      try {
        out[dep] = (await this.run({ ...input, datasource: dep, cursor: undefined, paging: undefined, maxItems: undefined, deps: undefined })).data;
      } catch (err) {
        throw dependencyFailed(input.datasource, dep, err);
      }
    }
    return out;
  }

  async run(input: RunInput): Promise<DatasourceOutput> {
    const { page, user } = input;
    const ds = this.datasource(page, input.datasource);
    const requires = merge(page.def.requires, ds.requires);
    if (ds.requires?.portalRoles) this.assertAccess(user.roles, ds.requires, `Datasource ${input.datasource}`);
    const depNames = this.dependencies(page, input.datasource);
    const depValues = depNames.length ? (input.deps ?? (await this.resolveDeps(input, depNames))) : {};
    const scope = this.datasourceScope(page, ds, user, input.params, depValues);

    if (ds.when !== undefined) {
      const ok = typeof ds.when === 'boolean' ? ds.when : await this.expr(() => renderString(ds.when as string, scope), 'when');
      if (ok !== true) return { data: null, provenance: null, skipped: true };
    }

    const paging = input.paging ?? ('paging' in ds ? (ds.paging === 'cursor' ? { cursor: input.cursor } : ds.paging) : undefined);
    const ttl = input.noCache ? 0 : (ds.cache?.ttl ?? 0);
    const key = ttl
      ? cacheKey([
          input.identity.kind === 'automation' ? 'automation' : input.identity.session.userOid,
          input.identity.mode,
          page.kind,
          page.key,
          page.sha256,
          input.datasource,
          input.params,
          paging ?? null,
          input.maxItems ?? null,
          depNames.length ? depValues : null,
        ])
      : '';
    if (ttl) {
      const hit = this.cache.get(key);
      if (hit) return { ...hit.value, provenance: hit.value.provenance ? { ...hit.value.provenance, cachedAt: hit.cachedAt.toISOString() } : null };
    }

    if (requires?.licences?.length && this.deps.licences) {
      const missing = missingLicences(await this.deps.licences.get(input.identity, { correlationId: input.correlationId }), requires.licences);
      if (missing?.length)
        throw new AppError(403, 'licence_required', `${requiresBadge(missing)}.`, { hint: 'The tenant has no subscription that includes this; ask your licensing admin.' });
    }

    let out: DatasourceOutput;
    if (ds.source === 'static') {
      out = { data: await this.expr(() => renderTemplate(ds.data, scope), 'data'), provenance: null };
    } else if (ds.source === 'runner') {
      out = await this.runScript(ds, input, scope);
    } else {
      const call = await this.buildCall(ds, page, input, scope, requires);
      call.paging = ds.source === 'graphBatch' || ds.source === 'logAnalytics' || ds.source === 'function' ? undefined : (paging as ServiceCall['paging']);
      if (input.maxItems ?? ('maxItems' in ds ? ds.maxItems : undefined)) call.maxItems = input.maxItems ?? (ds as { maxItems?: number }).maxItems;
      const res = await this.deps.outbound.execute(input.identity, call, { correlationId: input.correlationId, signal: input.signal });
      out = { data: res.data, provenance: res.provenance, ...(res.nextCursor ? { cursor: res.nextCursor } : {}) };
      if (ds.source === 'graphBatch') Object.assign(out, this.batchResult(res.data, input.identity, requires));
    }

    if (ds.transform) {
      const value = out.data;
      out.data = await this.expr(() => renderString(ds.transform!, { ...scope, value }), 'transform');
    }
    if (ttl) this.cache.set(key, out, ttl);
    return out;
  }

  private async expr<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'content_error', `The datasource ${what} expression failed: ${(err as Error).message}`, { hint: 'Fix the definition (adminforge validate) and publish it again.' });
    }
  }

  /** `source: runner`: read-mode PowerShell job; result = every `output` event's data, in order. */
  private async runScript(ds: Extract<Datasource, { source: 'runner' }>, input: RunInput, scope: Scope): Promise<DatasourceOutput> {
    const runner = this.deps.runner;
    if (!runner)
      throw new AppError(503, 'runner_not_configured', 'PowerShell datasources need the runner.', { hint: 'Set RUNNER_URL and RUNNER_SHARED_KEY in the env file (or use DATA_MODE=fixtures).' });
    // Datasources only read: the runner loads Get-* cmdlets only in read mode (§5.4).
    const decision = evaluate('read', { service: 'runner', method: 'POST', path: '/v1/jobs' });
    if (!decision.allowed) throw new AppError(403, 'policy_denied', decision.reason);
    const parameters = (await this.expr(() => renderTemplate<Record<string, unknown>>(ds.parameters ?? {}, scope), 'parameters')) ?? {};
    const started = performance.now();
    const identity: ExecutionIdentity = input.identity.kind === 'automation' ? { kind: 'automation', mode: 'read' } : { ...input.identity, mode: 'read' };
    const res = await runner.run(
      identity,
      { script: ds.script, sha256: ds.sha256, parameters, services: ds.services ?? [], timeoutSeconds: Math.min(ds.timeoutSeconds ?? 300, RUNNER_MAX_TIMEOUT_SECONDS), mode: 'read' },
      { correlationId: input.correlationId, signal: input.signal },
    );
    return { data: res.data, provenance: { service: 'runner', path: ds.script, ms: Math.round(performance.now() - started), ...(res.requestId ? { requestId: res.requestId } : {}) } };
  }

  private batchResult(data: unknown, identity: ExecutionIdentity, requires: Requires | undefined): Pick<DatasourceOutput, 'data' | 'errors'> {
    const responses = (data as { responses?: Array<{ id: string; status: number; body: unknown }> } | undefined)?.responses ?? [];
    const values: Record<string, unknown> = {};
    const errors: Record<string, ErrorInfo> = {};
    for (const r of responses) {
      if (r.status >= 200 && r.status < 300) values[r.id] = r.body ?? null;
      else {
        values[r.id] = null;
        const e = (r.body as { error?: { code?: string; message?: string } } | undefined)?.error;
        const apiErr = new ApiError(r.status, e?.code ?? `HTTP${r.status}`, e?.message ?? `Microsoft Graph returned ${r.status}.`);
        errors[r.id] = { code: apiErr.code, message: apiErr.message, hint: errorHint(apiErr, 'graph', identity, requires).hint };
      }
    }
    return { data: values, ...(Object.keys(errors).length ? { errors } : {}) };
  }

  private async buildCall(ds: Exclude<Datasource, { source: 'static' }>, page: LoadedPage, input: RunInput, scope: Scope, requires: Requires | undefined): Promise<ServiceCall> {
    const render = <T>(v: unknown, what: string) => this.expr(() => renderTemplate<T>(v, scope), what);
    const base = { requires };
    switch (ds.source) {
      case 'graph': {
        const r = await render<{ method?: string; path: string; query?: unknown; headers?: unknown; body?: unknown; beta?: boolean }>(ds.request, 'request');
        return { ...base, service: 'graph', method: r.method ?? 'GET', path: String(r.path), query: cleanQuery(r.query), headers: cleanHeaders(r.headers), body: r.body, beta: r.beta, pathTemplate: pathTemplateOf(ds.request.path) };
      }
      case 'graphBatch': {
        const reqs = await render<Record<string, { method?: string; path: string; query?: unknown; headers?: unknown; body?: unknown; beta?: boolean }>>(ds.requests, 'requests');
        const requests = Object.entries(reqs).map(([id, r]) => ({ id, method: r.method ?? 'GET', path: String(r.path), query: cleanQuery(r.query), headers: cleanHeaders(r.headers), body: r.body, beta: r.beta }));
        return { ...base, service: 'graph', method: 'POST', path: '/$batch', body: { requests }, pathTemplate: '/$batch' };
      }
      case 'arm': {
        const r = await render<{ method?: string; path: string; apiVersion: string; query?: unknown; headers?: unknown; body?: unknown }>(ds.request, 'request');
        return { ...base, service: 'arm', method: r.method ?? 'GET', path: String(r.path), apiVersion: r.apiVersion, query: cleanQuery(r.query), headers: cleanHeaders(r.headers), body: r.body, pathTemplate: pathTemplateOf(ds.request.path) };
      }
      case 'resourceGraph': {
        const query = await render<string>(ds.query, 'query');
        const subscriptions = ds.subscriptions === undefined ? undefined : await render<unknown>(ds.subscriptions, 'subscriptions');
        const managementGroups = ds.managementGroups === undefined ? undefined : await render<unknown>(ds.managementGroups, 'managementGroups');
        const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : typeof v === 'string' && v ? [v] : undefined);
        return {
          ...base,
          service: 'arm',
          method: 'POST',
          path: RESOURCE_GRAPH_PATH,
          apiVersion: RESOURCE_GRAPH_API_VERSION,
          body: { query: String(query), subscriptions: list(subscriptions), managementGroups: list(managementGroups) },
          pathTemplate: RESOURCE_GRAPH_PATH,
        };
      }
      case 'logAnalytics': {
        const workspace = String(await render<string>(ds.workspace, 'workspace'));
        const query = String(await render<string>(ds.query, 'query'));
        const timespan = ds.timespan ? String(await render<string>(ds.timespan, 'timespan')) : (defaultTimespan(page.def.params, input.params) ?? 'P1D');
        return { ...base, service: 'logAnalytics', method: 'POST', path: `/v1/workspaces/${encodeURIComponent(workspace)}/query`, body: { query, timespan }, pathTemplate: '/v1/workspaces/{workspace}/query' };
      }
      case 'function': {
        const r = await render<{ pathParams?: Record<string, unknown>; query?: unknown; headers?: unknown; body?: unknown }>(
          { pathParams: ds.pathParams, query: ds.query, headers: ds.headers, body: ds.body },
          'request',
        );
        return { ...base, service: 'function', method: 'GET', path: ds.operation, operation: ds.operation, connection: ds.connection, pathParams: r.pathParams, query: cleanQuery(r.query), headers: cleanHeaders(r.headers), body: r.body };
      }
      case 'runner':
        throw new AppError(500, 'internal', 'Runner datasources do not use the outbound executor.');
    }
  }
}
