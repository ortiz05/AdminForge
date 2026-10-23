import { Resolver } from 'node:dns/promises';
import type { AuditWriter } from '../audit/writer';
import { isIP } from 'node:net';
import tls from 'node:tls';
import type { Agent } from 'undici';
import { ApiError, FIXTURE_NOT_FOUND, readBodyText } from '@adminforge/connectors';
import { ExpressionError, renderString, renderTemplate, type Scope } from '@adminforge/expressions';
import {
  DEFAULT_LOG_ANALYTICS_WORKSPACE,
  isGuid,
  parseDuration,
  type Connection,
  type Probe,
  type ProbeCheck,
} from '@adminforge/schemas';
import { appOnlyScope, type AutomationTokenProvider } from '../auth/automation';
import { resourceScopes } from '../auth/token-broker';
import { missingLicences, requiresBadge, type LicenceService } from '../capabilities/licences';
import type { VaultStatus } from '../auth/vault';
import { AppError } from '../errors';
import { DEFENDER_NOT_PROVISIONED, OutboundError } from '../execution/outbound';
import type { ExecutionIdentity, OutboundExecutor } from '../execution/types';
import { newPinnedAgent, pinnedFetch, refusedAtConnect } from '../news/fetch-feed';
import type { ProbeStatus } from '../schedules/types';
import type { HostLookup } from './addresses';
import { fixtureNotFound } from './fixture-network';
import { assertCertTarget, assertProbeTarget, assertResolver, targetNotAllowed } from './targets';
import { aggregate, detailRows, runKql } from './kql';
import { fileRoundTrip, mailFlow, onlineMeeting } from './transactions';
import { classify, describeThresholds, effectiveThresholds, worst, type Thresholds } from './thresholds';
import { auditChain, vaultCredentials } from './platform-checks';

/**
 * Synthetic probes (R6, R12): every `check.kind`, run once. HTTP, DNS and TLS checks use Node built-ins; everything
 * that talks to Microsoft goes through the outbound executor as the automation identity (ADR-011) in read mode.
 * Statuses: ok / warn / crit from the primary metric and `thresholds` (or a failed expectation → crit, the target
 * being unreachable → crit); `error` = the probe could not evaluate (not configured, missing permission or licence,
 * bad content, no fixture for it with DATA_MODE=fixtures).
 */

export interface ProbeOutcome {
  probeKey: string;
  ts: Date;
  status: ProbeStatus;
  metric: number | null;
  unit: string;
  durationMs: number;
  message: string;
  /** ok | threshold | expectation_failed | unreachable | timeout | not_found | forbidden | licence_required | not_configured | content_error | fixture_not_found | insufficient_data | error */
  code: string;
  /** `{ rows, columns?, totalRows? }` for drill-down, or null. */
  details: ProbeDetails | null;
}

export interface ProbeDetails {
  rows: Record<string, unknown>[];
  columns?: Array<{ name: string; type: string }>;
  totalRows?: number;
  truncated?: boolean;
}

export type DnsType = Extract<ProbeCheck, { kind: 'dnsResolve' }>['type'];

/** DNS seam (tests). Answers as text: A/AAAA addresses, MX exchanges, TXT strings, `target:port` for SRV, … */
export interface DnsResolver {
  resolve(name: string, type: DnsType, opts: { server?: string; timeoutMs: number }): Promise<string[]>;
}

export interface PeerCertificate {
  validFrom: Date;
  validTo: Date;
  authorized: boolean;
  authorizationError?: string;
  subject?: string;
  issuer?: string;
}

/** TLS seam (tests). */
export interface TlsInspector {
  inspect(opts: {
    host: string;
    port: number;
    servername?: string;
    timeoutMs: number;
    /** The public address the guard checked for `host`: connected to instead of resolving `host` again. */
    address?: string;
  }): Promise<PeerCertificate>;
}

export interface ProbeDeps {
  outbound: OutboundExecutor;
  automation: AutomationTokenProvider | null;
  connection: (key: string) => Promise<Connection>;
  licences?: LicenceService | null;
  /** `env` scope (non-secret AF_* configuration plus PUBLIC_BASE_URL). */
  env: () => Record<string, unknown>;
  now: () => Date;
  spoTenantName?: string;
  fetch: typeof fetch;
  dns?: DnsResolver;
  tls?: TlsInspector;
  /** The portal's audit chain (`auditChain` checks); absent → the check reports not configured. */
  audit?: Pick<AuditWriter, 'verify' | 'verifyIncremental'>;
  /** The credentials read from Vault (`vaultCredentials` checks); absent → Vault isn't used here. */
  vault?: () => VaultStatus | null;
  /** Host → addresses for the HTTP probe SSRF guard (tests, DATA_MODE=fixtures); default: the system resolver. */
  lookup?: HostLookup;
  /**
   * DATA_MODE=fixtures: Microsoft is answered from the fixtures, so a request they have no answer for (404
   * `FixtureNotFound`) means the probe could not evaluate (`fixture_not_found`) — never a crit or a pass. Live, the code
   * means nothing special.
   */
  fixtures?: boolean;
  /** Tests: the resolver an HTTP probe's pinned connection uses (default: the system resolver). Forces the pinning. */
  connectLookup?: HostLookup;
  /** Waits between polls in synthetic transactions (tests); default a timer that stops on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The marker a synthetic transaction puts on its test item (tests); default a random id. */
  randomId?: () => string;
}

const AUTOMATION: ExecutionIdentity = { kind: 'automation', mode: 'read' };
const DAY_MS = 86_400_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** What a check reports; status defaults to the metric against the thresholds. */
export interface CheckResult {
  metric: number | null;
  message: string;
  status?: ProbeStatus;
  code?: string;
  details?: ProbeDetails | null;
}

export interface CheckContext {
  key: string;
  probe: Probe;
  deps: ProbeDeps;
  /** When the probe started (performance.now()) and how long it may take: synthetic transactions budget their waits. */
  startedAt: number;
  timeoutMs: number;
  /** Who the checks call Microsoft as: the schedule's identity (default the automation identity, ADR-014). */
  identity: ExecutionIdentity;
  scope: Scope;
  signal: AbortSignal;
  correlationId?: string;
  thresholds: Thresholds;
}

class NotConfigured extends AppError {
  constructor(message: string, hint?: string) {
    super(503, 'not_configured', message, hint ? { hint } : {});
  }
}

const ms = (t0: number) => Math.round(performance.now() - t0);
const text = async (v: string, scope: Scope) => {
  const out = await renderString(v, scope);
  return out === undefined || out === null ? '' : String(out).trim();
};

/**
 * A probe whose path names a setting this installation doesn't have (e.g. `${ env.AF_SUBSCRIPTION_ID }` unset) has
 * nothing to look at: "not configured", naming the setting, instead of a failed call to a broken path.
 */
function requireConfiguredPath(template: string, scope: Scope): void {
  const missing = unsetEnvKeys(template, scope);
  if (missing.length) throw nothingToLookAt(missing);
}

/** The `env.X` keys a template names. */
const envKeys = (template: string): string[] => [
  ...new Set([...template.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!)),
];

/** The `env.X` keys a template names that this installation doesn't set. */
function unsetEnvKeys(template: string, scope: Scope): string[] {
  const env = (scope.env ?? {}) as Record<string, unknown>;
  return envKeys(template).filter(
    (k) => env[k] === undefined || env[k] === null || String(env[k]).trim() === '',
  );
}

/**
 * A target (URL, DNS name) built from settings none of which this installation has: nothing to look at. Concatenating
 * an unset key renders without failing (`'check@' & env.AF_PRIMARY_DOMAIN`), so this is checked up front; a target that
 * falls back to another key still runs while one of them is set.
 */
function requireSomeSetting(template: string, scope: Scope): void {
  const unset = unsetEnvKeys(template, scope);
  if (unset.length && unset.length === envKeys(template).length) throw nothingToLookAt(unset);
}

const nothingToLookAt = (missing: string[]) =>
  new NotConfigured(
    `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, so this check has nothing to look at.`,
    'Set it in the env file, or turn the probe off.',
  );

type Query = Record<string, string | number | boolean>;
const cleanQuery = (q: unknown): Query | undefined => {
  if (!q || typeof q !== 'object') return undefined;
  const out: Query = {};
  for (const [k, v] of Object.entries(q as Record<string, unknown>))
    if (v !== undefined && v !== null && v !== '')
      out[k] = typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean);
  return out;
};

// ── Expectations (http, graph, arm, functionHealth) ────────────────────────────────────────────────────────────────

type Expect = { status?: number | number[]; bodyContains?: string; maxLatencyMs?: number } | undefined;

function expectResult(
  label: string,
  status: number,
  body: () => string,
  latency: number,
  expect: Expect,
): CheckResult {
  const wanted = expect?.status === undefined ? undefined : [expect.status].flat();
  const okStatus = wanted ? wanted.includes(status) : status >= 200 && status < 300;
  if (!okStatus)
    return {
      metric: latency,
      status: 'crit',
      code: 'expectation_failed',
      message: `${label} returned ${status}; expected ${wanted ? wanted.join(' or ') : '2xx'}.`,
    };
  if (expect?.bodyContains && !body().includes(expect.bodyContains))
    return {
      metric: latency,
      status: 'crit',
      code: 'expectation_failed',
      message: `${label} returned ${status} in ${latency} ms, but the response does not contain the expected text.`,
    };
  if (expect?.maxLatencyMs !== undefined && latency > expect.maxLatencyMs)
    return {
      metric: latency,
      status: 'crit',
      code: 'threshold',
      message: `${label} took ${latency} ms (limit ${expect.maxLatencyMs} ms).`,
    };
  return { metric: latency, message: `${label} ${status} in ${latency} ms.` };
}

const bodyText = (data: unknown) => (typeof data === 'string' ? data : JSON.stringify(data ?? ''));

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bytes of an HTTP probe's response searched for `expect.bodyContains` (the rest is never read). */
const HTTP_PROBE_MAX_BYTES = 1_000_000;

let probeAgent: Agent | undefined;

/**
 * The transport of an HTTP probe's request (DNS rebinding, SECURITY.md). On the real network — the platform fetch — the
 * connection is pinned like a news feed's: the socket resolves the host again through a lookup that refuses non-public
 * addresses, so the address the guard checked is the address connected to. The portal's own origin is called
 * directly (it may live on a private address and is always allowed); an injected fetch (tests, DATA_MODE=fixtures) is
 * used as is — it never opens a socket.
 */
function httpTransport(x: CheckContext, ownOrigin: boolean): typeof fetch {
  if (ownOrigin) return x.deps.fetch;
  if (x.deps.connectLookup) return pinnedFetch(newPinnedAgent(x.deps.connectLookup));
  if (x.deps.fetch !== globalThis.fetch) return x.deps.fetch;
  probeAgent ??= newPinnedAgent();
  return pinnedFetch(probeAgent);
}

async function http(c: Extract<ProbeCheck, { kind: 'http' }>, x: CheckContext): Promise<CheckResult> {
  requireSomeSetting(c.url, x.scope);
  let raw: string;
  try {
    raw = await text(c.url, x.scope);
  } catch (err) {
    // A URL built from a setting this installation doesn't have (`$encode(env.X)` of nothing): not configured, naming
    // it. (Checked only when the URL fails: a URL may fall back to another key, e.g. the mail domain or the primary.)
    const missing = err instanceof ExpressionError ? unsetEnvKeys(c.url, x.scope) : [];
    if (missing.length) throw nothingToLookAt(missing);
    throw err;
  }
  if (!/^https?:\/\/[^\s/]+/.test(raw))
    throw new NotConfigured(
      'The probe URL is empty or not an http(s) URL.',
      'Set the env keys the URL uses (for example PUBLIC_BASE_URL).',
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NotConfigured('The probe URL is not a valid URL.', 'Check the env keys the URL uses.');
  }
  // Probes observe; a POST must be asked for explicitly (it may change something on the other side).
  if (c.method === 'POST' && (c as { allowPost?: unknown }).allowPost !== true)
    throw new AppError(400, 'content_error', 'The probe sends POST without allowPost: true.', {
      hint: 'Use GET or HEAD, or set allowPost: true on the check if the endpoint is meant to be probed with POST.',
    });
  const transport = httpTransport(x, await assertProbeTarget(url, x));
  const headers = (await renderTemplate<Record<string, unknown>>(c.headers ?? {}, x.scope)) ?? {};
  const body = c.body === undefined ? undefined : await renderTemplate<unknown>(c.body, x.scope);
  const t0 = performance.now();
  let res: Response;
  try {
    // Redirects are not followed: a public URL could otherwise bounce the probe to an internal address.
    res = await transport(url.toString(), {
      method: c.method,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: x.signal,
      redirect: 'manual',
    });
  } catch (err) {
    // The name answered a non-public address at connect time (after a public one for the check): refused, not retried.
    if (refusedAtConnect(err))
      throw targetNotAllowed('resolves to a private, loopback or link-local address');
    throw err;
  }
  let content = '';
  if (c.expect?.bodyContains)
    content = (await readBodyText(res, HTTP_PROBE_MAX_BYTES, { onLimit: 'truncate' })).text;
  else await res.body?.cancel().catch(() => undefined);
  const result = expectResult('HTTP', res.status, () => content, ms(t0), c.expect);
  if (res.status >= 300 && res.status < 400 && result.code === 'expectation_failed')
    result.message = `${result.message} Redirects aren't followed; point the probe at the final URL.`;
  return result;
}

async function service(
  c: Extract<ProbeCheck, { kind: 'graph' | 'arm' }>,
  x: CheckContext,
): Promise<CheckResult> {
  requireConfiguredPath(c.path, x.scope);
  const path = await text(c.path, x.scope);
  const query = cleanQuery(await renderTemplate(c.query ?? {}, x.scope));
  const t0 = performance.now();
  let status: number;
  let data: unknown;
  try {
    const res = await x.deps.outbound.execute(
      x.identity,
      c.kind === 'graph'
        ? { service: 'graph', method: 'GET', path, query, beta: c.beta, requires: x.probe.requires }
        : {
            service: 'arm',
            method: 'GET',
            path,
            query,
            apiVersion: c.apiVersion,
            requires: x.probe.requires,
          },
      { signal: x.signal, correlationId: x.correlationId },
    );
    status = res.status;
    data = res.data;
  } catch (err) {
    // An expected non-2xx status (e.g. expect: { status: 404 }) is a pass, not an error — but a missing fixture
    // (DATA_MODE=fixtures) is no answer at all.
    const wanted = c.expect?.status === undefined ? [] : [c.expect.status].flat();
    if (
      err instanceof ApiError &&
      wanted.includes(err.status) &&
      !(x.deps.fixtures && err.code === FIXTURE_NOT_FOUND)
    )
      return expectResult(
        c.kind === 'graph' ? 'Microsoft Graph' : 'Azure Resource Manager',
        err.status,
        () => err.message,
        ms(t0),
        c.expect,
      );
    throw err;
  }
  return expectResult(
    c.kind === 'graph' ? 'Microsoft Graph' : 'Azure Resource Manager',
    status,
    () => bodyText(data),
    ms(t0),
    c.expect,
  );
}

/** Counts items of a Graph list (optionally an expression's selection of them) against the thresholds. */
async function graphCount(
  c: Extract<ProbeCheck, { kind: 'graphCount' }>,
  x: CheckContext,
): Promise<CheckResult> {
  requireConfiguredPath(c.path, x.scope);
  const path = await text(c.path, x.scope);
  const query = cleanQuery(await renderTemplate(c.query ?? {}, x.scope));
  const res = await x.deps.outbound.execute<{ value?: unknown[] }>(
    x.identity,
    {
      service: 'graph',
      method: 'GET',
      path,
      query,
      beta: c.beta,
      paging: 'all',
      maxItems: c.maxItems,
      requires: x.probe.requires,
    },
    { signal: x.signal, correlationId: x.correlationId },
  );
  const value = Array.isArray(res.data?.value) ? res.data.value : [];
  const picked = c.items ? await renderTemplate(c.items, { ...x.scope, value }) : value;
  const items = Array.isArray(picked) ? picked : picked === undefined || picked === null ? [] : [picked];
  const fields = c.fields ?? ['id', 'displayName'];
  const field = (item: unknown, name: string) =>
    name
      .split('.')
      .reduce<unknown>(
        (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
        item,
      );
  const rows = items
    .slice(0, c.detailsLimit)
    .map((item) => Object.fromEntries(fields.map((f) => [f, field(item, f) ?? null])));
  const capped = value.length >= c.maxItems;
  return {
    metric: items.length,
    message: `${items.length} item${items.length === 1 ? '' : 's'} counted${capped ? ` (only the first ${c.maxItems} read)` : ''}; ${describeThresholds(x.thresholds)}.`,
    details: { rows, totalRows: items.length, truncated: items.length > rows.length || capped },
  };
}

async function tokenAcquisition(
  c: Extract<ProbeCheck, { kind: 'tokenAcquisition' }>,
  x: CheckContext,
): Promise<CheckResult> {
  const automation = x.deps.automation;
  if (!automation)
    throw new NotConfigured(
      'The automation identity is not configured.',
      'Set AF_AUTOMATION_CLIENT_ID and AF_AUTOMATION_CERT_PATH (or AF_AUTOMATION_CLIENT_SECRET).',
    );
  let scope: string | undefined;
  let label: string;
  if (c.connection) {
    const conn = await x.deps.connection(c.connection);
    const audience = await text(conn.audience, x.scope);
    if (!audience)
      throw new NotConfigured(
        `The audience of connection ${c.connection} is not configured.`,
        'Set the env key it references.',
      );
    scope = appOnlyScope(audience);
    label = `connection ${c.connection}`;
  } else {
    scope = resourceScopes({ AF_SPO_TENANT_NAME: x.deps.spoTenantName })[c.service!]?.[0];
    if (!scope)
      throw new NotConfigured(
        `${c.service} is not configured for this installation.`,
        c.service === 'sharepointAdmin' ? 'Set AF_SPO_TENANT_NAME.' : undefined,
      );
    label = c.service!;
  }
  const t0 = performance.now();
  await automation.token(scope, { forceRefresh: true });
  const latency = ms(t0);
  return {
    metric: latency,
    message: `Got an app-only token for ${label} in ${latency} ms (${automation.credential} credential).`,
  };
}

async function functionHealth(
  c: Extract<ProbeCheck, { kind: 'functionHealth' }>,
  x: CheckContext,
): Promise<CheckResult> {
  const conn = await x.deps.connection(c.connection);
  const op = c.operation ?? conn.health;
  if (!op)
    throw new AppError(
      500,
      'content_error',
      `Connection ${c.connection} has no health operation; set check.operation.`,
    );
  const t0 = performance.now();
  const res = await x.deps.outbound.execute(
    x.identity,
    {
      service: 'function',
      method: 'GET',
      path: op,
      operation: op,
      connection: c.connection,
      requires: x.probe.requires,
    },
    { signal: x.signal, correlationId: x.correlationId },
  );
  return expectResult('Function App', res.status, () => bodyText(res.data), ms(t0), c.expect);
}

const defaultDns: DnsResolver = {
  async resolve(name, type, opts) {
    const r = new Resolver({ timeout: opts.timeoutMs, tries: 2 });
    if (opts.server) r.setServers([opts.server]);
    switch (type) {
      case 'A':
        return r.resolve4(name);
      case 'AAAA':
        return r.resolve6(name);
      case 'CNAME':
        return r.resolveCname(name);
      case 'MX':
        return (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
      case 'TXT':
        return (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
      case 'NS':
        return r.resolveNs(name);
      case 'SRV':
        return (await r.resolveSrv(name)).map((s) => `${s.name}:${s.port}`);
      case 'CAA':
        return (await r.resolveCaa(name)).map((c) =>
          Object.entries(c)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(' '),
        );
    }
  },
};

async function dnsResolve(
  c: Extract<ProbeCheck, { kind: 'dnsResolve' }>,
  x: CheckContext,
): Promise<CheckResult> {
  requireSomeSetting(c.name, x.scope);
  const name = (await text(c.name, x.scope)).replace(/\.$/, '');
  if (!name || name.startsWith('.') || /undefined|null/.test(name))
    throw new NotConfigured(
      'The name to resolve is empty.',
      'Set the env keys it uses (for example AF_PRIMARY_DOMAIN).',
    );
  assertResolver(c.resolver, x);
  const t0 = performance.now();
  let answers: string[];
  try {
    answers = await (x.deps.dns ?? defaultDns).resolve(name, c.type, {
      server: c.resolver,
      timeoutMs: x.probe.timeoutMs ?? 5_000,
    });
  } catch (err) {
    if (err instanceof AppError) throw err; // the resolver could not evaluate (e.g. no fixture), not a DNS answer
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN')
      return {
        metric: ms(t0),
        status: 'crit',
        code: 'expectation_failed',
        message: `No ${c.type} record (${code}).`,
        details: { rows: [] },
      };
    return {
      metric: ms(t0),
      status: 'crit',
      code: 'unreachable',
      message: `The DNS lookup failed (${code ?? (err as Error).message}).`,
    };
  }
  const latency = ms(t0);
  const details: ProbeDetails = { rows: answers.slice(0, 50).map((answer) => ({ type: c.type, answer })) };
  const min = c.expect?.minAnswers ?? 1;
  if (answers.length < min)
    return {
      metric: latency,
      status: 'crit',
      code: 'expectation_failed',
      message: `${answers.length} ${c.type} answer(s); expected at least ${min}.`,
      details,
    };
  const missing = (c.expect?.contains ?? []).filter(
    (needle) => !answers.some((a) => a.toLowerCase().includes(needle.toLowerCase())),
  );
  if (missing.length)
    return {
      metric: latency,
      status: 'crit',
      code: 'expectation_failed',
      message: `${answers.length} ${c.type} answer(s), but ${missing.length} expected value(s) are missing.`,
      details,
    };
  return {
    metric: latency,
    message: `${answers.length} ${c.type} answer(s) in ${latency} ms${c.expect?.contains?.length ? '; expected values present' : ''}.`,
    details,
  };
}

const defaultTls: TlsInspector = {
  inspect: ({ host, port, servername, timeoutMs, address }) =>
    new Promise<PeerCertificate>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: address ?? host,
          port,
          ...(servername ? { servername } : {}),
          rejectUnauthorized: false,
          timeout: timeoutMs,
        },
        () => {
          const cert = socket.getPeerCertificate();
          const out: PeerCertificate = {
            validFrom: new Date(cert.valid_from),
            validTo: new Date(cert.valid_to),
            authorized: socket.authorized,
            ...(socket.authorizationError ? { authorizationError: String(socket.authorizationError) } : {}),
            ...(cert.subject?.CN ? { subject: String(cert.subject.CN) } : {}),
            ...(cert.issuer ? { issuer: String(cert.issuer.O ?? cert.issuer.CN ?? '') } : {}),
          };
          socket.end();
          if (!cert.valid_to) reject(new Error('The server sent no certificate.'));
          else resolve(out);
        },
      );
      socket.once('timeout', () =>
        socket.destroy(Object.assign(new Error('TLS handshake timed out'), { code: 'ETIMEDOUT' })),
      );
      socket.once('error', reject);
    }),
};

async function certExpiry(
  c: Extract<ProbeCheck, { kind: 'certExpiry' }>,
  x: CheckContext,
): Promise<CheckResult> {
  const host = await text(c.host, x.scope);
  if (!host || !/^[A-Za-z0-9.:-]+$/.test(host))
    throw new NotConfigured(
      'The host to check is empty or not a host name.',
      'Set the env keys it uses (for example PUBLIC_BASE_URL).',
    );
  const servername = c.servername ?? (isIP(host) ? undefined : host);
  let cert: PeerCertificate;
  try {
    // Live (or a test's lookup); fixtures open no socket. A name that doesn't resolve is unreachable, like a refusal.
    const address = !x.deps.tls || x.deps.lookup ? await assertCertTarget(host, c.port, x) : undefined;
    cert = await (x.deps.tls ?? defaultTls).inspect({
      host,
      port: c.port,
      servername,
      timeoutMs: x.probe.timeoutMs ?? 10_000,
      ...(address ? { address } : {}),
    });
  } catch (err) {
    if (err instanceof AppError) throw err; // the inspector could not evaluate (e.g. no fixture), not a handshake
    const code = (err as NodeJS.ErrnoException).code;
    return {
      metric: null,
      status: 'crit',
      code: 'unreachable',
      message: `Could not complete a TLS handshake on port ${c.port} (${code ?? (err as Error).message}).`,
    };
  }
  const days = Math.floor((cert.validTo.getTime() - x.deps.now().getTime()) / DAY_MS);
  let status = classify(days, x.thresholds) as ProbeStatus;
  if (!cert.authorized) status = worst(status, 'warn');
  const trust = cert.authorized
    ? ''
    : `; the certificate is not trusted (${cert.authorizationError ?? 'unknown reason'})`;
  return {
    metric: days,
    status,
    code: status === 'ok' ? 'ok' : cert.authorized ? 'threshold' : 'untrusted',
    message: `${days < 0 ? `Certificate expired ${-days} days ago` : `Certificate expires in ${days} days`}${trust}.`,
    details: {
      rows: [
        {
          subject: cert.subject ?? null,
          issuer: cert.issuer ?? null,
          validFrom: cert.validFrom.toISOString(),
          validTo: cert.validTo.toISOString(),
          authorized: cert.authorized,
        },
      ],
    },
  };
}

interface GraphCredential {
  keyId?: string;
  displayName?: string | null;
  endDateTime?: string;
}
interface GraphApplication {
  id: string;
  appId?: string;
  displayName?: string;
  passwordCredentials?: GraphCredential[];
  keyCredentials?: GraphCredential[];
}

async function appCredentialExpiry(
  c: Extract<ProbeCheck, { kind: 'appCredentialExpiry' }>,
  x: CheckContext,
): Promise<CheckResult> {
  const res = await x.deps.outbound.execute<{ value?: GraphApplication[] }>(
    x.identity,
    {
      service: 'graph',
      method: 'GET',
      path: '/applications',
      query: { $select: 'id,appId,displayName,passwordCredentials,keyCredentials', $top: 999 },
      paging: 'all',
      maxItems: 50_000,
      requires: x.probe.requires,
    },
    { signal: x.signal, correlationId: x.correlationId },
  );
  const include = new Set(c.include ?? ['secrets', 'certificates']);
  const now = x.deps.now().getTime();
  const creds = (res.data?.value ?? []).flatMap((app) => [
    ...(include.has('secrets')
      ? (app.passwordCredentials ?? []).map((k) => ({ app, k, type: 'secret' }))
      : []),
    ...(include.has('certificates')
      ? (app.keyCredentials ?? []).map((k) => ({ app, k, type: 'certificate' }))
      : []),
  ]);
  const rows = creds
    .filter((r) => r.k.endDateTime && !Number.isNaN(Date.parse(r.k.endDateTime)))
    .map((r) => ({
      application: r.app.displayName ?? null,
      appId: r.app.appId ?? null,
      type: r.type,
      credential: r.k.displayName ?? r.k.keyId ?? null,
      endDateTime: r.k.endDateTime!,
      daysRemaining: Math.floor((Date.parse(r.k.endDateTime!) - now) / DAY_MS),
    }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
  const active = rows.filter((r) => r.daysRemaining >= 0);
  const expired = rows.length - active.length;
  const metric = active[0]?.daysRemaining ?? null;
  const warnDays = x.thresholds.warn ?? c.warnDays;
  const soon = active.filter((r) => r.daysRemaining <= warnDays).length;
  const expiredNote = expired ? `; ${expired} expired credential(s) still listed` : '';
  return {
    metric,
    status: metric === null ? 'ok' : undefined,
    message:
      metric === null
        ? `No unexpired ${[...include].join(' or ')} on ${res.data?.value?.length ?? 0} app registrations${expiredNote}.`
        : `Soonest credential expires in ${metric} days; ${soon} within ${warnDays} days${expiredNote}.`,
    details: {
      rows: [...active.slice(0, 40), ...rows.filter((r) => r.daysRemaining < 0).slice(-10)],
      totalRows: rows.length,
    },
  };
}

interface GraphSku {
  skuPartNumber?: string;
  consumedUnits?: number;
  capabilityStatus?: string;
  prepaidUnits?: { enabled?: number; warning?: number; suspended?: number };
}

async function licenseThreshold(
  c: Extract<ProbeCheck, { kind: 'licenseThreshold' }>,
  x: CheckContext,
): Promise<CheckResult> {
  const sku = await text(c.sku, x.scope);
  if (!sku)
    throw new NotConfigured(
      'The SKU to check is empty.',
      'Set the env key the probe uses for the SKU part number.',
    );
  const res = await x.deps.outbound.execute<{ value?: GraphSku[] }>(
    x.identity,
    { service: 'graph', method: 'GET', path: '/subscribedSkus', requires: x.probe.requires },
    { signal: x.signal, correlationId: x.correlationId },
  );
  const hit = (res.data?.value ?? []).find((s) => s.skuPartNumber?.toLowerCase() === sku.toLowerCase());
  if (!hit)
    return {
      metric: null,
      status: 'error',
      code: 'not_found',
      message: `The tenant has no ${sku} subscription.`,
      details: { rows: [] },
    };
  const enabled = (hit.prepaidUnits?.enabled ?? 0) + (hit.prepaidUnits?.warning ?? 0);
  const consumed = hit.consumedUnits ?? 0;
  const row = {
    skuPartNumber: hit.skuPartNumber ?? sku,
    capabilityStatus: hit.capabilityStatus ?? null,
    enabled,
    consumed,
    available: Math.max(enabled - consumed, 0),
  };
  if (enabled <= 0)
    return {
      metric: null,
      status: 'crit',
      code: 'expectation_failed',
      message: `${row.skuPartNumber} has no enabled seats (${consumed} assigned).`,
      details: { rows: [row] },
    };
  const metric = Math.round((consumed / enabled) * 1000) / 10;
  return {
    metric,
    message: `${row.skuPartNumber}: ${consumed} of ${enabled} seats in use (${metric}%).`,
    details: { rows: [row] },
  };
}

interface GraphSignIn {
  status?: { errorCode?: number; failureReason?: string };
}

async function signInHealth(
  c: Extract<ProbeCheck, { kind: 'signInHealth' }>,
  x: CheckContext,
): Promise<CheckResult> {
  const since = new Date(x.deps.now().getTime() - parseDuration(c.window))
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  let appId: string | undefined;
  if (c.appId) {
    appId = await text(c.appId, x.scope);
    if (!isGuid(appId))
      throw new NotConfigured(
        'The application id to check is not configured.',
        'Set the env key the probe uses (for example AF_READ_CLIENT_ID).',
      );
  }
  let resourceId: string | undefined;
  if (c.resourceId) {
    resourceId = await text(c.resourceId, x.scope);
    if (!isGuid(resourceId))
      throw new NotConfigured(
        'The resource id to check is not configured.',
        'Set the env key the probe uses, or use the resource application id itself.',
      );
  }
  const max = 20_000;
  const res = await x.deps.outbound.execute<{ value?: GraphSignIn[] }>(
    x.identity,
    {
      service: 'graph',
      method: 'GET',
      path: '/auditLogs/signIns',
      query: {
        $filter: `createdDateTime ge ${since}${appId ? ` and appId eq '${appId.toLowerCase()}'` : ''}${resourceId ? ` and resourceId eq '${resourceId.toLowerCase()}'` : ''}`,
        $select: 'id,status,createdDateTime',
        $top: 999,
      },
      paging: 'all',
      maxItems: max,
      requires: x.probe.requires,
    },
    { signal: x.signal, correlationId: x.correlationId },
  );
  const list = res.data?.value ?? [];
  const failures = list.filter((s) => (s.status?.errorCode ?? 0) !== 0);
  const reasons = new Map<string, { errorCode: number; failureReason: string; signIns: number }>();
  for (const f of failures) {
    const k = String(f.status?.errorCode);
    const cur = reasons.get(k) ?? {
      errorCode: f.status?.errorCode ?? 0,
      failureReason: f.status?.failureReason ?? '',
      signIns: 0,
    };
    cur.signIns++;
    reasons.set(k, cur);
  }
  const details: ProbeDetails = {
    rows: [...reasons.values()].sort((a, b) => b.signIns - a.signIns).slice(0, 15),
    totalRows: list.length,
    truncated: list.length >= max,
  };
  if (list.length < (c.minSignIns ?? 1))
    return {
      metric: null,
      status: 'ok',
      code: 'insufficient_data',
      message: `Only ${list.length} sign-in(s) in the last ${c.window}; below the ${c.minSignIns ?? 1} needed to judge.`,
      details,
    };
  const metric = Math.round((failures.length / list.length) * 1000) / 10;
  // The most common failure, so the result says why (an aggregate: no names, unlike the details rows).
  const top = details.rows[0] as { errorCode: number; failureReason: string; signIns: number } | undefined;
  const reason = top?.failureReason
    ? ` (${top.failureReason.length > 120 ? `${top.failureReason.slice(0, 117)}…` : top.failureReason})`
    : '';
  return {
    metric,
    message: `${metric}% of ${list.length}${list.length >= max ? '+' : ''} sign-ins failed in the last ${c.window}${top ? `; most often error ${top.errorCode}${reason}, ${top.signIns} time${top.signIns === 1 ? '' : 's'}` : ''}.`,
    details,
  };
}

const list = (v: unknown) =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && !!s)
    : typeof v === 'string' && v
      ? [v]
      : undefined;

async function kql(c: Extract<ProbeCheck, { kind: 'kql' }>, x: CheckContext): Promise<CheckResult> {
  const query = await text(c.query, x.scope);
  const workspace =
    c.source === 'logAnalytics'
      ? await text(c.workspace ?? DEFAULT_LOG_ANALYTICS_WORKSPACE, x.scope)
      : undefined;
  const timespan = c.timespan
    ? await text(c.timespan, x.scope)
    : c.source === 'logAnalytics'
      ? 'P1D'
      : undefined;
  const r = await runKql(
    x.identity,
    x.deps.outbound,
    {
      source: c.source,
      query,
      subscriptions:
        c.subscriptions === undefined ? undefined : list(await renderTemplate(c.subscriptions, x.scope)),
      managementGroups:
        c.managementGroups === undefined
          ? undefined
          : list(await renderTemplate(c.managementGroups, x.scope)),
      workspace,
      timespan,
      maxRows: c.metric === 'rowCount' ? Math.max(c.detailsLimit, 1000) : 5000,
    },
    { signal: x.signal, correlationId: x.correlationId },
  );
  const metric =
    c.metric === 'rowCount' ? r.totalRows : aggregate(r.rows, c.metric.column, c.metric.aggregate);
  const details: ProbeDetails = {
    rows: detailRows(r.rows, c.detailsLimit),
    columns: r.columns,
    totalRows: r.totalRows,
    truncated: r.totalRows > c.detailsLimit,
  };
  const what =
    c.metric === 'rowCount'
      ? `${r.totalRows} row(s)`
      : `${c.metric.aggregate}(${c.metric.column}) = ${metric ?? 'no value'} over ${r.totalRows} row(s)`;
  const partial = r.partialError ? ` Partial results: ${r.partialError.message}` : '';
  if (metric === null)
    return { metric: null, status: 'ok', code: 'insufficient_data', message: `${what}.${partial}`, details };
  const limits = describeThresholds(x.thresholds);
  return { metric, message: `${what}${limits ? ` (${limits})` : ''}.${partial}`, details };
}

// ── Running a probe ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Turns an exception into a status: the target failing → crit; the probe unable to evaluate → error. */
export function probeFailure(
  err: unknown,
  kind: ProbeCheck['kind'],
  timeoutMs: number,
  timedOut: boolean,
  opts: { fixtures?: boolean } = {},
): Pick<ProbeOutcome, 'status' | 'code' | 'message'> {
  const name = (err as Error)?.name;
  if (timedOut || name === 'TimeoutError')
    return { status: 'crit', code: 'timeout', message: `No result within ${timeoutMs} ms.` };
  if (err instanceof OutboundError || err instanceof ApiError) {
    // DATA_MODE=fixtures with no fixture for the request: the probe could not evaluate, like the HTTP, DNS and TLS
    // checks' missing fixtures — never a crit, and never the fixture fetch's message (it names the file to create).
    if (opts.fixtures && err.code === FIXTURE_NOT_FOUND)
      return probeFailure(fixtureNotFound('Microsoft request'), kind, timeoutMs, false);
    const hint = err instanceof OutboundError ? ` ${err.hint}` : '';
    if (err instanceof OutboundError && err.licence)
      return { status: 'error', code: 'licence_required', message: `${err.message}${hint}` };
    // Defender XDR not set up for the tenant yet: the probe can't check, nothing is denied.
    if (err instanceof OutboundError && err.message === DEFENDER_NOT_PROVISIONED)
      return { status: 'error', code: 'not_configured', message: `${err.message}${hint}` };
    if (err.status === 401 || err.status === 403)
      return {
        status: 'error',
        code: 'forbidden',
        message: `Access denied (${err.status}): ${err.message}${hint}`,
      };
    if (err.status === 400) return { status: 'error', code: 'bad_request', message: `${err.message}${hint}` };
    if (err.status === 404) return { status: 'crit', code: 'not_found', message: `${err.message}${hint}` };
    return {
      status: 'crit',
      code: err.status === 0 ? 'unreachable' : 'upstream_error',
      message: `${err.message}${hint}`,
    };
  }
  if (err instanceof AppError) {
    const hint = err.extras.hint ? ` ${err.extras.hint}` : '';
    if (/not_configured$/.test(err.code))
      return { status: 'error', code: 'not_configured', message: `${err.message}${hint}` };
    if (err.code === 'licence_required')
      return { status: 'error', code: 'licence_required', message: `${err.message}${hint}` };
    if (err.code === 'automation_token_failed')
      return {
        status: kind === 'tokenAcquisition' ? 'crit' : 'error',
        code: 'token_failed',
        message: `${err.message}${hint}`,
      };
    if (err.code === 'policy_denied') return { status: 'error', code: 'policy_denied', message: err.message };
    if (err.code === 'definition_not_found')
      return { status: 'error', code: 'content_error', message: err.message };
    return {
      status: 'error',
      code:
        err.code === 'invalid_request' || err.code === 'content_error' || err.code === 'invalid_workspace'
          ? 'content_error'
          : err.code,
      message: `${err.message}${hint}`,
    };
  }
  if (err instanceof ExpressionError)
    return {
      status: 'error',
      code: 'content_error',
      message: `An expression in the probe failed: ${err.message}`,
    };
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return {
      status: 'crit',
      code: 'unreachable',
      message: `Could not reach the endpoint (${cause?.code ?? cause?.message ?? 'network error'}).`,
    };
  }
  return { status: 'error', code: 'error', message: (err as Error)?.message ?? String(err) };
}

const CHECKS: {
  [K in ProbeCheck['kind']]: (c: Extract<ProbeCheck, { kind: K }>, x: CheckContext) => Promise<CheckResult>;
} = {
  http,
  graph: service,
  graphCount,
  arm: service,
  tokenAcquisition,
  functionHealth,
  dnsResolve,
  certExpiry,
  appCredentialExpiry,
  licenseThreshold,
  signInHealth,
  kql,
  auditChain,
  vaultCredentials,
  mailFlow,
  fileRoundTrip,
  onlineMeeting,
};

/** Runs one probe and evaluates it. Never throws: failures become `crit` or `error` outcomes. */
export async function runProbe(
  key: string,
  probe: Probe,
  deps: ProbeDeps,
  opts: { signal?: AbortSignal; correlationId?: string; identity?: ExecutionIdentity } = {},
): Promise<ProbeOutcome> {
  const ts = deps.now();
  const thresholds = effectiveThresholds(probe);
  const timeoutMs = probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const t0 = performance.now();
  const base = { probeKey: key, ts, unit: thresholds.unit };
  try {
    if (probe.requires?.licences?.length && deps.licences) {
      const missing = missingLicences(
        await deps.licences.get(AUTOMATION, { correlationId: opts.correlationId }),
        probe.requires.licences,
      );
      if (missing?.length)
        return {
          ...base,
          status: 'error',
          code: 'licence_required',
          metric: null,
          durationMs: ms(t0),
          message: `${requiresBadge(missing)}.`,
          details: null,
        };
    }
    const scope: Scope = { env: deps.env(), now: ts.toISOString() };
    const check = CHECKS[probe.check.kind] as (c: ProbeCheck, x: CheckContext) => Promise<CheckResult>;
    const r = await check(probe.check, {
      key,
      probe,
      deps,
      startedAt: t0,
      timeoutMs,
      identity: opts.identity ?? AUTOMATION,
      scope,
      signal,
      correlationId: opts.correlationId,
      thresholds,
    });
    const status = r.status ?? (r.metric === null ? 'ok' : classify(r.metric, thresholds));
    return {
      ...base,
      status,
      metric: r.metric,
      durationMs: ms(t0),
      message: r.message,
      code: r.code ?? (status === 'ok' ? 'ok' : 'threshold'),
      details: r.details ?? null,
    };
  } catch (err) {
    const f = probeFailure(err, probe.check.kind, timeoutMs, timeout.aborted && !opts.signal?.aborted, {
      fixtures: deps.fixtures,
    });
    return { ...base, ...f, metric: null, durationMs: ms(t0), details: null };
  }
}
