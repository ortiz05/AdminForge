import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ApiError,
  buildUrl,
  createArmClient,
  createFunctionClient,
  createGraphClient,
  createLogAnalyticsClient,
  createResourceGraphClient,
  evaluate,
  RESOURCE_GRAPH_API_VERSION,
  RESOURCE_GRAPH_PATH,
  type FunctionConnection,
  type GraphRequest,
  type Mode,
  type Provenance,
  type ServiceId,
  type Sleep,
  type TokenProvider,
} from '@adminforge/connectors';
import { renderString } from '@adminforge/expressions';
import type { Connection, Requires } from '@adminforge/schemas';
import { appOnlyScope, type AutomationTokenProvider } from '../auth/automation';
import { isArmed, type SessionRecord } from '../auth/session-store';
import { decodeClaimsChallenge, resourceScopes, type BrokerService, type TokenBroker } from '../auth/token-broker';
import { NotArmed, partitionKey, ReauthRequired, type AuthClient } from '../auth/types';
import type { Config } from '../config';
import { AppError, toAppError } from '../errors';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall, ServiceCallResult } from './types';

/**
 * The single outbound path (ADR-003, §5.4): request policy → token for the identity/mode → connector → normalised
 * errors and provenance. Datasources, the playbook engine and the scheduler all call Microsoft through here.
 *
 * - Policy: read mode is default-deny (safe methods + allowlisted read POSTs, `$batch` sub-requests checked one by one);
 *   writes leave only when the call says `declaredWrite` — which only code rendering *published* content may set.
 * - Tokens: delegated → the session's Read/Write app via the TokenBroker (CAE claims challenges handled);
 *   automation → app-only tokens of the automation identity; DATA_MODE=fixtures → no tokens at all.
 * - Paging: `all` collects up to maxItems; cursor pages hand out sealed, opaque cursors (HMAC-bound to the call) so
 *   a client can never steer a nextLink/skip token at another resource.
 * - Concurrency: per service, and per identity per service. Correlation id → client-request-id / x-ms-client-request-id.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com';
export const ARM_BASE = 'https://management.azure.com';
const DEFAULT_MAX_ITEMS = 5000;
const MAX_ITEMS = 100_000;
const MAX_PAGES = 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PS_SERVICES = new Set<ServiceId>(['exchange', 'teams', 'sharepointAdmin', 'runner']);

export type OutboundConfig = Pick<
  Config,
  'DATA_MODE' | 'AF_SPO_TENANT_NAME' | 'OUTBOUND_CONCURRENCY' | 'OUTBOUND_USER_CONCURRENCY' | 'OUTBOUND_TIMEOUT_MS' | 'TOKEN_CACHE_KEY'
>;

export interface OutboundDeps {
  config: OutboundConfig;
  /** Delegated tokens (null with mock sign-in). */
  broker: TokenBroker | null;
  /** Delegated tokens for function-connection audiences (null with mock sign-in). */
  auth: AuthClient | null;
  automation: AutomationTokenProvider | null;
  /** Network fetch, or the fixture fetch in DATA_MODE=fixtures. */
  fetch: typeof fetch;
  /** Published `kind: connection` definitions by key (function calls). */
  connection?: (key: string) => Promise<Connection>;
  /** `${ env.X }` scope for connection baseUrl/audience. */
  env?: () => Record<string, unknown>;
  now?: () => Date;
  sleep?: Sleep;
  maxRetries?: number;
  /**
   * Called after every read of a secret-bearing endpoint (App Service app settings) — the values are already stripped
   * to names; the API wires this to the audit log.
   */
  onSensitiveRead?: (info: SensitiveRead) => Promise<void> | void;
}

export interface SensitiveRead {
  identity: ExecutionIdentity;
  service: ServiceId;
  method: string;
  /** The actual path (audit only, never shown as provenance). */
  path: string;
  correlationId: string;
  result: 'success' | 'failure';
  /** Setting names returned (never values). */
  names?: number;
}

/** App Service app settings: allowed in read mode (policy) but only names ever leave the executor. */
const APP_SETTINGS_LIST = /\/providers\/Microsoft\.Web\/sites\/[^/]+(\/slots\/[^/]+)?\/config\/appsettings\/list$/i;

/** `{ properties: { NAME: value } }` → `{ properties: { NAME: null } }` — values never reach transforms, runs or browsers. */
export function settingNamesOnly(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const d = data as Record<string, unknown>;
  const props = d.properties && typeof d.properties === 'object' && !Array.isArray(d.properties) ? (d.properties as Record<string, unknown>) : {};
  return { ...d, properties: Object.fromEntries(Object.keys(props).map((k) => [k, null])) };
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** Refused by the request policy (ADR-003). Never retried. */
export class PolicyDenied extends AppError {
  constructor(reason: string) {
    super(403, 'policy_denied', reason, { hint: /Arm write access/.test(reason) ? 'Arm write access, then run it from a published playbook.' : undefined });
    this.name = 'PolicyDenied';
  }
}

/**
 * A Microsoft API error with an actionable hint. Still an ApiError, so `isTransient()` and status checks keep working
 * for the engine and the scheduler; routes turn it into a response with `outboundAppError`.
 */
export class OutboundError extends ApiError {
  constructor(
    base: ApiError,
    readonly service: ServiceId,
    readonly hint: string,
    /** The failure is a missing tenant licence rather than a permission. */
    readonly licence: boolean,
    readonly provenance?: Provenance,
  ) {
    super(base.status, base.code, base.message, base.requestId, base.claims);
    this.name = 'OutboundError';
  }
}

/** Response mapping for anything the executor throws (OutboundError keeps its hint). */
export function outboundAppError(err: unknown): AppError {
  if (err instanceof OutboundError) {
    const s = err.status;
    const [status, code] =
      err.licence ? [403, 'licence_required']
      : s === 401 || s === 403 ? [403, 'upstream_forbidden']
      : s === 404 ? [404, 'upstream_not_found']
      : s === 429 ? [429, 'throttled']
      : s === 400 ? [400, 'upstream_bad_request']
      : s === 0 ? [504, 'upstream_unreachable']
      : [502, 'upstream_error'];
    return new AppError(status as number, code as string, err.message, { hint: err.hint });
  }
  return toAppError(err);
}

const LICENCE_CODES = /AadPremiumLicenseRequired|RequestFromNonPremiumTenant|NotLicensed|LicenseNotFound|Tenant_?License/i;
const LICENCE_TEXT = /licen[cs]e|subscription (?:is )?required|premium|\bP[12]\b|sku|not provisioned|tenant does not have/i;

/** The hint for a failed call: missing scopes, roles or licences for 401/403, throttling/temporary failures otherwise. */
export function errorHint(err: ApiError, service: ServiceId, identity: Pick<ExecutionIdentity, 'kind' | 'mode'>, requires?: Requires, connection?: string): { hint: string; licence: boolean } {
  const ref = err.requestId ? ` Microsoft request-id ${err.requestId}.` : '';
  const licence =
    ((err.status === 401 || err.status === 403 || err.status === 400) && (LICENCE_CODES.test(err.code) || LICENCE_TEXT.test(err.message))) ||
    // Microsoft 365 usage reports answer 404 UnknownTenantId for tenants without Microsoft 365 workloads.
    (err.status === 404 && /^UnknownTenantId$/i.test(err.code));
  if (licence) {
    const need = requires?.licences?.length ? ` It requires ${requires.licences.join(' or ')}.` : '';
    return { hint: `Your tenant's licences don't include this feature.${need}${ref}`, licence: true };
  }
  if (err.status === 401 || err.status === 403) {
    const scopes = service === 'function' ? (connection ? requires?.scopes?.connections?.[connection] : undefined) : (requires?.scopes as Record<string, string[] | undefined> | undefined)?.[service];
    const parts: string[] = [];
    if (service === 'arm') {
      const roles = requires?.azureRoles?.length ? requires.azureRoles.join(' or ') : 'Reader';
      parts.push(identity.kind === 'automation' ? `The automation identity needs the Azure role ${roles} on the target scope.` : `Needs the Azure role ${roles} on the target scope (your account's Azure RBAC).`);
    } else if (identity.kind === 'automation') {
      parts.push(scopes?.length ? `The automation identity needs the application permission ${scopes.join(', ')} (check with adminforge validate --scopes).` : 'The automation identity lacks an application permission for this call (check with adminforge validate --scopes).');
    } else {
      const app = identity.mode === 'write' ? 'Write' : 'Read';
      parts.push(scopes?.length ? `Needs ${scopes.join(', ')} consented to the AdminForge ${app} app.` : `The AdminForge ${app} app or your account lacks permission for this call.`);
    }
    if (identity.kind === 'delegated' && requires?.entraRoles?.length) parts.push(`You also need an Entra role such as ${requires.entraRoles.join(' or ')} — activate it in PIM if you are eligible.`);
    return { hint: `${parts.join(' ')}${ref}`, licence: false };
  }
  if (err.status === 404) return { hint: `Not found: the object may have been deleted, or the feature is not available in this tenant.${ref}`, licence: false };
  if (err.status === 429) return { hint: `Microsoft throttled this request. Try again in a minute.${ref}`, licence: false };
  if (err.status === 400) return { hint: `Microsoft rejected the request; check the filter and search values.${ref}`, licence: false };
  if (err.status === 0) return { hint: 'Could not reach the service (network problem or timeout). Try again shortly.', licence: false };
  return { hint: `The service had a temporary problem. Try again shortly.${ref}`, licence: false };
}

// ── Provenance path templates ───────────────────────────────────────────────

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Path for provenance: ids, UPNs and resource names become placeholders (no PII, stable across objects). */
export function templatePath(path: string): string {
  const segments = path.split('?')[0]!.split('/');
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const d = safeDecode(seg).replace(/\('([^']*)'\)/g, "('{id}')").replace(/=\s*'[^']*'/g, "='{id}'");
    const prev = segments[i - 1]?.toLowerCase();
    if (GUID.test(d)) out.push(prev === 'subscriptions' ? '{subscriptionId}' : '{id}');
    else if (d.includes('@')) out.push('{upn}');
    else if (prev === 'resourcegroups') out.push('{resourceGroup}');
    else if (/^\d{3,}$/.test(d) || (/^[A-Za-z0-9+/=_-]{24,}$/.test(d) && /\d/.test(d))) out.push('{id}');
    else out.push(d === safeDecode(seg) ? seg : d);
  }
  // ARM: …/providers/<Namespace>/<type>/<name>[/<type>/<name>…] → names become {name}.
  const p = out.findIndex((s) => s.toLowerCase() === 'providers');
  if (p >= 0 && /^\{subscriptionId\}$|^\{resourceGroup\}$/.test(out[p - 1] ?? '')) {
    // `config/<appsettings|web|…>` children have fixed, non-identifying names.
    for (let i = p + 3; i < out.length; i += 2) if (!out[i]!.startsWith('{') && out[i] && out[i - 1]!.toLowerCase() !== 'config') out[i] = '{name}';
  }
  return out.join('/');
}

// ── Sealed cursors ──────────────────────────────────────────────────────────

class CursorSeal {
  private readonly key: Buffer;
  constructor(secret?: string) {
    this.key = secret ? createHash('sha256').update(`adminforge:cursor:${secret}`).digest() : randomBytes(32);
  }
  private mac(binding: string, value: string) {
    return createHmac('sha256', this.key).update(binding).update('\n').update(value).digest('base64url');
  }
  seal(binding: string, value: string): string {
    return `${Buffer.from(value, 'utf8').toString('base64url')}.${this.mac(binding, value)}`;
  }
  open(binding: string, cursor: string): string {
    const [payload, mac] = cursor.split('.');
    const value = payload ? Buffer.from(payload, 'base64url').toString('utf8') : '';
    const expected = Buffer.from(this.mac(binding, value));
    const given = Buffer.from(mac ?? '');
    if (!payload || given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new AppError(400, 'invalid_cursor', 'The paging cursor is not valid for this data. Reload the list.');
    return value;
  }
}

// ── Concurrency ─────────────────────────────────────────────────────────────

class Semaphore {
  active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  get idle() {
    return this.active === 0 && this.queue.length === 0;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal!.reason ?? new Error('aborted'));
      };
      this.queue.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

class Limiter {
  private readonly sems = new Map<string, Semaphore>();
  constructor(
    private readonly perService: number,
    private readonly perIdentity: number,
  ) {}
  private sem(key: string, max: number) {
    let s = this.sems.get(key);
    if (!s) this.sems.set(key, (s = new Semaphore(max)));
    return s;
  }
  /** Identity slot first, then the service slot (waiting for one never holds the other). */
  async run<T>(service: ServiceId, identity: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const userKey = `${service}:${identity}`;
    const user = this.sem(userKey, this.perIdentity);
    await user.acquire(signal);
    const svc = this.sem(service, this.perService);
    try {
      await svc.acquire(signal);
      try {
        return await fn();
      } finally {
        svc.release();
      }
    } finally {
      user.release();
      if (user.idle) this.sems.delete(userKey);
    }
  }
  /** Active calls (tests/metrics). */
  activeFor(key: string) {
    return this.sems.get(key)?.active ?? 0;
  }
}

// ── $batch normalisation ────────────────────────────────────────────────────

interface BatchItem {
  id: string;
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
  beta?: boolean;
}

/**
 * `$batch` bodies may use Graph's wire format (`url`) or AdminForge's request spec (`path` + `query`); both become
 * the wire format for the policy check and BatchItems for the (auto-chunked) connector call.
 */
function normaliseBatch(body: unknown, beta: boolean | undefined): { wire: { requests: Array<Record<string, unknown>> }; items: BatchItem[] } {
  const requests = (body as { requests?: unknown } | undefined)?.requests;
  if (!Array.isArray(requests) || requests.length === 0) throw new AppError(400, 'invalid_request', '$batch needs a non-empty requests array.');
  const items: BatchItem[] = requests.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : String(i + 1);
    const method = typeof r.method === 'string' ? r.method.toUpperCase() : 'GET';
    const headers = r.headers as Record<string, string> | undefined;
    const itemBeta = typeof r.beta === 'boolean' ? r.beta : beta;
    if (typeof r.url === 'string') {
      const u = new URL(`https://graph.invalid${r.url.startsWith('/') ? '' : '/'}${r.url}`);
      const query: Record<string, string> = {};
      for (const [k, v] of u.searchParams) query[k] = v;
      return { id, method, path: u.pathname.replace(/^\/(v1\.0|beta)(?=\/)/, ''), query, headers, body: r.body, beta: itemBeta };
    }
    if (typeof r.path !== 'string') throw new AppError(400, 'invalid_request', `$batch request ${id} needs a url or a path.`);
    return { id, method, path: r.path, query: r.query as BatchItem['query'], headers, body: r.body, beta: itemBeta };
  });
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new AppError(400, 'invalid_request', '$batch request ids must be unique.');
  const wire = {
    requests: items.map((i) => {
      let url: string;
      try {
        url = buildUrl('', { path: i.path, query: i.query }).replace(/^\/(v1\.0|beta)/, '');
      } catch {
        url = i.path;
      }
      return { id: i.id, method: i.method ?? 'GET', url, ...(i.headers ? { headers: i.headers } : {}), ...(i.body !== undefined ? { body: i.body } : {}) };
    }),
  };
  return { wire, items };
}

// ── Function connections ────────────────────────────────────────────────────

interface ResolvedFunction {
  connection: FunctionConnection;
  operation: string;
  method: string;
  /** Filled path (for the policy check). */
  path: string;
  /** Operation path template (provenance). */
  template: string;
  mode: Mode;
  audience: string;
  scopes: string[];
}

const asText = async (value: string, env: Record<string, unknown>, what: string): Promise<string> => {
  const out = await renderString(value, { env });
  if (typeof out !== 'string' || !out) throw new AppError(503, 'connection_not_configured', `The connection's ${what} is not configured.`, { hint: 'Set the env key it references in the AdminForge env file.' });
  return out;
};

// ── The executor ────────────────────────────────────────────────────────────

const identityKey = (identity: ExecutionIdentity) => (identity.kind === 'automation' ? 'automation' : identity.session.userOid);

type Query = Record<string, string | number | boolean | undefined | null>;

interface Dispatch {
  identity: ExecutionIdentity;
  call: ServiceCall;
  method: string;
  path: string;
  body: unknown;
  batch?: BatchItem[];
  fn?: ResolvedFunction;
  getToken: TokenProvider;
  correlationId: string;
  signal?: AbortSignal;
}

interface Dispatched {
  data: unknown;
  status: number;
  requestId?: string;
  nextCursor?: string;
  /** Provenance path when it differs from the default template. */
  path?: string;
}

export class Outbound implements OutboundExecutor {
  private readonly limiter: Limiter;
  private readonly cursors: CursorSeal;
  private readonly now: () => Date;

  constructor(private readonly deps: OutboundDeps) {
    this.limiter = new Limiter(deps.config.OUTBOUND_CONCURRENCY, deps.config.OUTBOUND_USER_CONCURRENCY);
    this.cursors = new CursorSeal(deps.config.TOKEN_CACHE_KEY);
    this.now = deps.now ?? (() => new Date());
  }

  /** In-flight calls for a service (tests/metrics). */
  active(service: ServiceId): number {
    return this.limiter.activeFor(service);
  }

  async execute<T = unknown>(identity: ExecutionIdentity, call: ServiceCall, opts: { correlationId?: string; signal?: AbortSignal } = {}): Promise<ServiceCallResult<T>> {
    const service = call.service;
    if (PS_SERVICES.has(service)) throw new AppError(501, 'not_supported', `${service} work runs through the PowerShell runner, not as a REST call.`);
    const correlationId = opts.correlationId ?? randomUUID();

    let method = (call.method || 'GET').toUpperCase();
    let path = call.path;
    let body = call.body;
    let batch: BatchItem[] | undefined;
    let fn: ResolvedFunction | undefined;
    if (service === 'function') {
      fn = await this.resolveFunction(call);
      method = fn.method;
      path = fn.path;
    } else if (service === 'graph' && method === 'POST' && path === '/$batch') {
      const n = normaliseBatch(call.body, call.beta);
      body = n.wire;
      batch = n.items;
    }

    // Policy (ADR-003). `declaredRead` for functions comes from the published connection, never from the caller.
    const decision = evaluate(identity.mode, {
      service,
      method,
      path,
      body,
      declaredWrite: call.declaredWrite === true,
      declaredRead: fn ? fn.mode === 'read' : call.declaredRead === true,
    });
    if (!decision.allowed) throw new PolicyDenied(decision.reason);

    const template = call.pathTemplate ?? fn?.template ?? templatePath(path);
    const sensitive = service === 'arm' && method === 'POST' && APP_SETTINGS_LIST.test(path);
    const started = performance.now();
    try {
      const out = await this.limiter.run(
        service,
        identityKey(identity),
        () => this.withToken(identity, service, fn, (getToken) => this.dispatch({ identity, call, method, path, body, batch, fn, getToken, correlationId, signal: opts.signal })),
        opts.signal,
      );
      if (sensitive) {
        out.data = settingNamesOnly(out.data);
        const names = Object.keys(((out.data as { properties?: object } | undefined)?.properties ?? {}) as object).length;
        await this.deps.onSensitiveRead?.({ identity, service, method, path, correlationId, result: 'success', names });
      }
      const provenance: Provenance = { service, path: out.path ?? template, ms: Math.round(performance.now() - started), ...(out.requestId ? { requestId: out.requestId } : {}) };
      return { data: out.data as T, status: out.status, provenance, ...(out.nextCursor ? { nextCursor: out.nextCursor } : {}) };
    } catch (err) {
      if (sensitive) await Promise.resolve(this.deps.onSensitiveRead?.({ identity, service, method, path, correlationId, result: 'failure' })).catch(() => undefined);
      if (err instanceof ApiError && !(err instanceof OutboundError)) {
        const provenance: Provenance = { service, path: template, ms: Math.round(performance.now() - started), ...(err.requestId ? { requestId: err.requestId } : {}) };
        const { hint, licence } = errorHint(err, service, identity, call.requires, call.connection);
        throw new OutboundError(err, service, hint, licence, provenance);
      }
      if (err instanceof Error && !(err instanceof AppError) && !(err instanceof ReauthRequired) && !(err instanceof NotArmed) && /^(Invalid .* path|ARM requests need|Log Analytics|Resource Graph query|Operation ".*" needs|Connection .* has no|nextLink points|Invalid value for path)/.test(err.message)) {
        throw new AppError(400, 'invalid_request', err.message);
      }
      throw err;
    }
  }

  // ── Tokens ──

  private async withToken<T>(identity: ExecutionIdentity, service: ServiceId, fn: ResolvedFunction | undefined, run: (getToken: TokenProvider) => Promise<T>): Promise<T> {
    if (this.deps.config.DATA_MODE === 'fixtures') return run(async () => 'fixture-token');
    if (identity.kind === 'automation') {
      const automation = this.deps.automation;
      if (!automation)
        throw new AppError(503, 'automation_not_configured', 'The automation identity is not configured.', {
          hint: 'Set AF_AUTOMATION_CLIENT_ID and AF_AUTOMATION_CERT_PATH (or AF_AUTOMATION_CLIENT_SECRET) in the env file.',
        });
      const scope = fn ? appOnlyScope(fn.audience) : resourceScopes(this.deps.config)[service as BrokerService]?.[0];
      if (!scope) throw new AppError(503, 'service_not_configured', `${service} is not configured for this installation.`);
      return withClaimsRetry((claims) => run(() => automation.token(scope, claims ? { claims } : {})));
    }
    const { session, mode } = identity;
    if (fn) {
      const auth = this.deps.auth;
      if (!auth) throw liveDataUnavailable();
      return withClaimsRetry((claims) => run(() => delegatedToken(auth, session, mode, fn.scopes, this.now, claims)), mode);
    }
    const broker = this.deps.broker;
    if (!broker) throw liveDataUnavailable();
    return broker.withToken(session, service as BrokerService, mode, run);
  }

  // ── Connectors ──

  private client(d: Dispatch) {
    return {
      getToken: d.getToken,
      fetch: this.deps.fetch,
      correlationId: d.correlationId,
      timeoutMs: this.deps.config.OUTBOUND_TIMEOUT_MS,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.maxRetries !== undefined ? { maxRetries: this.deps.maxRetries } : {}),
    };
  }

  private binding(d: Dispatch, extra = '') {
    return `${d.call.service}|${d.method}|${d.path}|${d.call.beta ? 'beta' : ''}|${extra}`;
  }

  private dispatch(d: Dispatch): Promise<Dispatched> {
    switch (d.call.service) {
      case 'graph':
        return this.graph(d);
      case 'arm':
        return d.method === 'POST' && d.path.toLowerCase() === RESOURCE_GRAPH_PATH.toLowerCase() ? this.resourceGraph(d) : this.arm(d);
      case 'logAnalytics':
        return this.logAnalytics(d);
      case 'function':
        return this.callFunction(d);
      default:
        throw new AppError(501, 'not_supported', `${d.call.service} is not callable here.`);
    }
  }

  private maxItems(call: ServiceCall) {
    return Math.min(Math.max(call.maxItems ?? DEFAULT_MAX_ITEMS, 1), MAX_ITEMS);
  }

  private async graph(d: Dispatch): Promise<Dispatched> {
    const client = createGraphClient(this.client(d));
    const { call } = d;
    if (d.batch) {
      const out = await client.batch(d.batch);
      return { status: 200, data: { responses: d.batch.map((i) => ({ id: i.id, status: out[i.id]?.status ?? 0, body: out[i.id]?.body })) } };
    }
    const req: GraphRequest = { method: d.method, path: d.path, query: call.query, headers: call.headers, body: d.body, beta: call.beta };
    const base = `${GRAPH_BASE}/${call.beta ? 'beta' : 'v1.0'}/`;
    const checkLink = (url: string) => {
      if (!url.startsWith(base)) throw new AppError(502, 'upstream_error', 'Microsoft Graph returned a nextLink outside Graph; refusing to follow it.');
      return url;
    };
    const paging = call.paging ?? 'none';
    if (paging === 'all') {
      const max = this.maxItems(call);
      const value: unknown[] = [];
      let url: string | undefined = buildUrl(GRAPH_BASE, req);
      let first: { status: number; requestId?: string; count?: unknown } | undefined;
      for (let page = 0; url && value.length < max && page < MAX_PAGES; page++) {
        const r: { data: { value?: unknown[]; '@odata.nextLink'?: string; '@odata.count'?: unknown }; status: number; requestId?: string } = await client.request(req, url);
        first ??= { status: r.status, requestId: r.requestId, count: r.data?.['@odata.count'] };
        value.push(...(r.data?.value ?? []));
        url = r.data?.['@odata.nextLink'];
        if (url) checkLink(url);
      }
      return { status: first?.status ?? 200, requestId: first?.requestId, data: { value: value.slice(0, max), ...(first?.count !== undefined ? { '@odata.count': first.count } : {}) } };
    }
    let url: string;
    if (typeof paging === 'object' && paging.cursor) url = checkLink(this.cursors.open(this.binding(d), paging.cursor));
    else {
      const query: Query = { ...call.query };
      if (typeof paging === 'object' && paging.pageSize && query.$top === undefined) query.$top = paging.pageSize;
      url = buildUrl(GRAPH_BASE, { ...req, query });
    }
    const r = await client.request<Record<string, unknown> | undefined>(req, url);
    if (typeof paging === 'object' && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
      const { '@odata.nextLink': next, ...rest } = r.data;
      return { status: r.status, requestId: r.requestId, data: rest, ...(typeof next === 'string' ? { nextCursor: this.cursors.seal(this.binding(d), checkLink(next)) } : {}) };
    }
    return { status: r.status, requestId: r.requestId, data: r.data };
  }

  private async arm(d: Dispatch): Promise<Dispatched> {
    const { call } = d;
    if (!call.apiVersion) throw new AppError(400, 'invalid_request', `ARM calls need an apiVersion (${d.method} ${templatePath(d.path)}).`);
    const client = createArmClient({ ...this.client(d), ...(call.pollTimeoutMs ? { maxPollMs: call.pollTimeoutMs } : {}) });
    const req = { method: d.method, path: d.path, apiVersion: call.apiVersion, query: call.query, headers: call.headers, body: d.body };
    const checkLink = (url: string) => {
      if (!url.startsWith(`${ARM_BASE}/`)) throw new AppError(502, 'upstream_error', 'Azure Resource Manager returned a nextLink outside ARM; refusing to follow it.');
      return url;
    };
    const paging = call.paging ?? 'none';
    if (paging === 'all') {
      const max = this.maxItems(call);
      const value: unknown[] = [];
      let first: { status: number; requestId?: string } | undefined;
      for await (const page of client.pages(req, MAX_PAGES)) {
        first ??= { status: 200 };
        value.push(...page);
        if (value.length >= max) break;
      }
      return { status: first?.status ?? 200, data: { value: value.slice(0, max) } };
    }
    if (typeof paging === 'object') {
      const r = paging.cursor
        ? await client.request<Record<string, unknown> | undefined>(req, checkLink(this.cursors.open(this.binding(d), paging.cursor)))
        : await client.request<Record<string, unknown> | undefined>(req);
      const { nextLink, ...rest } = (r.data ?? {}) as Record<string, unknown>;
      return { status: r.status, requestId: r.requestId, data: rest, ...(typeof nextLink === 'string' && nextLink ? { nextCursor: this.cursors.seal(this.binding(d), checkLink(nextLink)) } : {}) };
    }
    const write = d.method !== 'GET' && d.method !== 'HEAD';
    const r = write && call.poll !== false ? await client.requestAndWait(req) : await client.request(req);
    return { status: r.status, requestId: r.requestId, data: r.data };
  }

  private async resourceGraph(d: Dispatch): Promise<Dispatched> {
    const { call } = d;
    const b = (d.body ?? {}) as { query?: string; subscriptions?: string[]; managementGroups?: string[] };
    if (typeof b.query !== 'string' || !b.query.trim()) throw new AppError(400, 'invalid_request', 'Resource Graph calls need a query.');
    const rg = createResourceGraphClient({ ...this.client(d), apiVersion: call.apiVersion ?? RESOURCE_GRAPH_API_VERSION });
    const q = { query: b.query, subscriptions: b.subscriptions, managementGroups: b.managementGroups };
    const paging = call.paging ?? 'none';
    const binding = this.binding(d, createHash('sha256').update(JSON.stringify(q)).digest('hex'));
    if (paging === 'all') {
      const max = this.maxItems(call);
      const value: unknown[] = [];
      let first: { totalRecords?: number; requestId?: string } | undefined;
      for await (const page of rg.pages({ ...q, top: 1000 }, MAX_PAGES)) {
        first ??= { totalRecords: page.totalRecords, requestId: page.requestId };
        value.push(...page.rows);
        if (value.length >= max) break;
      }
      return { status: 200, requestId: first?.requestId, data: { value: value.slice(0, max), totalRecords: first?.totalRecords ?? value.length } };
    }
    const cursor = typeof paging === 'object' ? paging : undefined;
    const page = await rg.query({ ...q, top: cursor?.pageSize, skipToken: cursor?.cursor ? this.cursors.open(binding, cursor.cursor) : undefined });
    return {
      status: 200,
      requestId: page.requestId,
      data: { value: page.rows, totalRecords: page.totalRecords, count: page.count, resultTruncated: page.resultTruncated ?? false },
      ...(cursor && page.skipToken ? { nextCursor: this.cursors.seal(binding, page.skipToken) } : {}),
    };
  }

  private async logAnalytics(d: Dispatch): Promise<Dispatched> {
    const m = /^\/v1\/workspaces\/([^/]+)\/query$/i.exec(d.path);
    if (!m) throw new AppError(400, 'invalid_request', 'Log Analytics calls must POST /v1/workspaces/{workspaceId}/query.');
    const b = (d.body ?? {}) as { query?: string; timespan?: string };
    const la = createLogAnalyticsClient(this.client(d));
    const r = await la.query({ workspace: safeDecode(m[1]!), query: b.query ?? '', timespan: b.timespan });
    return {
      status: r.status,
      requestId: r.requestId,
      path: '/v1/workspaces/{workspace}/query',
      data: { value: r.rows, tables: r.tables, ...(r.partialError ? { partialError: r.partialError } : {}) },
    };
  }

  private async callFunction(d: Dispatch): Promise<Dispatched> {
    const fn = d.fn!;
    const allowWrite = fn.mode === 'write' && d.call.declaredWrite === true && d.identity.mode === 'write';
    const client = createFunctionClient({ ...this.client(d), connection: fn.connection, allowWrite });
    const r = await client.call(fn.operation, { pathParams: d.call.pathParams, query: d.call.query, headers: d.call.headers, body: d.body });
    return { status: r.status, requestId: r.requestId, data: r.data };
  }

  private async resolveFunction(call: ServiceCall): Promise<ResolvedFunction> {
    if (!call.connection) throw new AppError(400, 'invalid_request', 'function calls need a connection.');
    if (!this.deps.connection) throw new AppError(503, 'connection_not_configured', 'Connections are not available in this process.');
    const def = await this.deps.connection(call.connection);
    const name = call.operation ?? (call.path && !call.path.startsWith('/') ? call.path : undefined);
    if (!name || !Object.hasOwn(def.operations, name)) throw new AppError(400, 'invalid_request', `Connection ${call.connection} has no operation "${name ?? ''}".`);
    const env = this.deps.env?.() ?? {};
    const baseUrl = await asText(def.baseUrl, env, 'baseUrl');
    const audience = (await asText(def.audience, env, 'audience')).replace(/\/+$/, '');
    const operations: FunctionConnection['operations'] = {};
    for (const [k, op] of Object.entries(def.operations)) operations[k] = { method: op.method, path: op.path, mode: op.mode, ...(op.idempotent !== undefined ? { idempotent: op.idempotent } : {}) };
    const connection: FunctionConnection = { id: call.connection, baseUrl, operations };
    let resolved: { method: string; path: string; mode: Mode };
    try {
      resolved = createFunctionClient({ getToken: async () => '', connection }).resolve(name, { pathParams: call.pathParams });
    } catch (err) {
      throw new AppError(400, 'invalid_request', (err as Error).message);
    }
    const scopes = (def.scopes?.length ? def.scopes : ['user_impersonation']).map((s) => (s.includes('/') ? s : `${audience}/${s}`));
    return { connection, operation: name, method: resolved.method, path: resolved.path, template: def.operations[name]!.path, mode: resolved.mode, audience, scopes };
  }
}

const liveDataUnavailable = () =>
  new AppError(409, 'live_data_unavailable', 'Live data needs Entra sign-in.', { hint: 'Use DATA_MODE=fixtures with AUTH_MODE=mock.' });

/** Runs `attempt`; a 401 with a CAE claims challenge is retried once with a token minted for those claims. */
async function withClaimsRetry<T>(attempt: (claims?: string) => Promise<T>, mode?: Mode): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    const claims = err instanceof ApiError && err.status === 401 && err.claims ? decodeClaimsChallenge(err.claims) : undefined;
    if (!claims) throw err;
    try {
      return await attempt(claims);
    } catch (retryErr) {
      if (mode && retryErr instanceof ApiError && retryErr.status === 401 && retryErr.claims) throw new ReauthRequired(mode === 'write' ? 'write' : 'read', claims);
      throw retryErr;
    }
  }
}

/** Delegated token for a connection audience from the session's Read (or, armed, Write) account. */
async function delegatedToken(auth: AuthClient, session: SessionRecord, mode: Mode, scopes: string[], now: () => Date, claims?: string): Promise<string> {
  const extra = claims ? { claims } : {};
  if (mode === 'write') {
    if (!isArmed(session, now())) throw new NotArmed();
    return auth.token({ kind: 'write', partitionKey: partitionKey('write', session.idHash), homeAccountId: session.writeAccountId!, scopes, ...extra });
  }
  if (!session.readAccountId) throw new ReauthRequired('read', claims);
  return auth.token({ kind: 'read', partitionKey: partitionKey('read', session.idHash), homeAccountId: session.readAccountId, scopes, ...extra });
}

export function createOutboundExecutor(deps: OutboundDeps): Outbound {
  return new Outbound(deps);
}
