import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ApiError,
  buildUrl,
  cleanPath,
  createArmClient,
  createFunctionClient,
  createGraphClient,
  createLogAnalyticsClient,
  createResourceGraphClient,
  DEFAULT_MAX_RESPONSE_BYTES,
  describePath,
  evaluate,
  hasControlChars,
  LOG_ANALYTICS_BASE_URL,
  RESOURCE_GRAPH_API_VERSION,
  RESOURCE_GRAPH_PATH,
  RESPONSE_TOO_LARGE,
  type FunctionConnection,
  type Gate,
  type GraphRequest,
  type Mode,
  type Provenance,
  type RetryInfo,
  type ServiceId,
  type Sleep,
  type TokenProvider,
} from '@adminforge/connectors';
import { renderString } from '@adminforge/expressions';
import type { Connection, Requires } from '@adminforge/schemas';
import { appOnlyScope, type AutomationTokenProvider } from '../auth/automation';
import { isArmed, type SessionRecord } from '../auth/session-store';
import {
  decodeClaimsChallenge,
  resourceScopes,
  type BrokerService,
  type TokenBroker,
} from '../auth/token-broker';
import { NotArmed, partitionKey, ReauthRequired, type AuthClient } from '../auth/types';
import type { Config } from '../config';
import { AppError, toAppError } from '../errors';
import { writesPausedError } from './emergency';
import { ProtectedObjects, type ProtectedConfig, type WriteTarget } from './protected';
import { timeoutOverride } from './timeouts';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall, ServiceCallResult } from './types';

/**
 * The single outbound path (ADR-003, §5.4): request policy → token for the identity/mode → connector → normalised
 * errors and provenance. Datasources, the playbook engine and the scheduler all call Microsoft through here.
 *
 * - Policy: read mode is default-deny (safe methods + allowlisted read POSTs, `$batch` sub-requests checked one by one);
 *   writes leave only when the call says `declaredWrite` — which only code rendering *published* content may set.
 * - Declared writes are refused while an administrator has paused changes (./emergency.ts) and when they name one of
 *   AdminForge's protected objects (./protected.ts).
 * - Tokens: delegated → the session's Read/Write app via the TokenBroker (CAE claims challenges handled);
 *   automation → app-only tokens of the automation identity; DATA_MODE=fixtures → no tokens at all.
 * - Paging: `all` collects up to maxItems; cursor pages hand out sealed, opaque cursors (HMAC-bound to the call) so
 *   a client can never steer a nextLink/skip token at another resource.
 * - Concurrency: per service, and per identity per service, taken for each attempt (each page, each retry) and
 *   released while a throttled call waits; a person's request that can't get a slot within OUTBOUND_QUEUE_WAIT_MS
 *   is refused as busy. Correlation id → client-request-id / x-ms-client-request-id.
 * - Timeouts: OUTBOUND_TIMEOUT_MS with one more try, or one longer attempt for the slow reads in
 *   OUTBOUND_TIMEOUT_OVERRIDES (./timeouts.ts). The caller's abort signal reaches every request and wait.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com';
export const ARM_BASE = 'https://management.azure.com';
const DEFAULT_MAX_ITEMS = 5000;
const MAX_ITEMS = 100_000;
const MAX_PAGES = 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PS_SERVICES = new Set<ServiceId>(['exchange', 'teams', 'sharepointAdmin', 'runner']);
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export type OutboundConfig = Pick<
  Config,
  | 'DATA_MODE'
  | 'AF_SPO_TENANT_NAME'
  | 'OUTBOUND_CONCURRENCY'
  | 'OUTBOUND_USER_CONCURRENCY'
  | 'OUTBOUND_TIMEOUT_MS'
  | 'TOKEN_CACHE_KEY'
> &
  Partial<
    Pick<
      Config,
      | 'OUTBOUND_MAX_BYTES'
      | 'AF_CONNECTION_AUDIENCE_HOSTS'
      | 'OUTBOUND_TIMEOUT_OVERRIDES'
      | 'OUTBOUND_QUEUE_WAIT_MS'
      | 'OUTBOUND_CRAWL_SHARE'
      | 'OUTBOUND_AUTOMATION_CONCURRENCY'
    >
  > &
  ProtectedConfig;

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
  /** Per-call telemetry (service, path template, status, duration, throttling, request id): logged by the API. */
  onCall?: (record: CallRecord) => void;
  /** Emergency stop: true while an administrator has paused changes (every declared write is refused). */
  writesPaused?: () => Promise<boolean>;
  /** Protected-object cache lifetime (tests; default 10 min). */
  protectedTtlMs?: number;
}

/** One Microsoft API call, for logs and metrics: never ids, query values or bodies (the path is a template). */
export interface CallRecord {
  service: ServiceId;
  method: string;
  path: string;
  status: number;
  ms: number;
  /** The final answer was 429, or an attempt was throttled and retried. */
  throttled: boolean;
  /** Attempts retried (throttling, server errors, network failures, timeouts). */
  retries: number;
  /** Of those, retried because Microsoft throttled (429, or 503 with Retry-After). */
  throttledRetries: number;
  identity: ExecutionIdentity['kind'];
  mode: string;
  correlationId: string;
  requestId?: string;
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
const APP_SETTINGS_LIST =
  /\/providers\/Microsoft\.Web\/sites\/[^/]+(\/slots\/[^/]+)?\/config\/appsettings\/list$/i;

/** `{ properties: { NAME: value } }` → `{ properties: { NAME: null } }` — values never reach transforms, runs or browsers. */
export function settingNamesOnly(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const d = data as Record<string, unknown>;
  const props =
    d.properties && typeof d.properties === 'object' && !Array.isArray(d.properties)
      ? (d.properties as Record<string, unknown>)
      : {};
  return { ...d, properties: Object.fromEntries(Object.keys(props).map((k) => [k, null])) };
}

// ── Connection audiences ──────────────────────────────────────────────────────

/**
 * Microsoft first-party resources by host: never a connection's audience, even when listed in
 * AF_CONNECTION_AUDIENCE_HOSTS. (Microsoft's own top-level domains — `.microsoft`, `.azure`, `.office`, … — included.)
 */
const MICROSOFT_RESOURCE_HOSTS =
  /(^|\.)(microsoft\.com|microsoftonline\.com|microsoftonline-p\.com|windows\.net|windows\.com|azure\.com|azure\.net|office\.com|office\.net|office365\.com|outlook\.com|live\.com|sharepoint\.com|sharepoint-df\.com|loganalytics\.io|applicationinsights\.io|dynamics\.com|powerbi\.com|fabric\.microsoft\.com|visualstudio\.com|skype\.com|lync\.com|botframework\.com|microsoftazuread-sso\.com|microsoft|azure|office|windows|bing|xbox)$/i;
/** Well-known first-party resource application ids (the `0000000x-0000-0000-c000-…` / `…-0ff1-ce00-…` families too). */
const MICROSOFT_RESOURCE_APP_IDS = new Set([
  '797f4846-ba00-4fd7-ba43-dac1f8f63013', // Azure Resource Manager
  'ca7f3f0b-7d91-482c-8e09-c5d840d0eac5', // Log Analytics API
  'cfa8b339-82a2-471a-a3c9-0fc0be7a4093', // Azure Key Vault
  'e406a681-f3d4-42a8-90b6-c2b029497af1', // Azure Storage
  '022907d3-0f1b-48f7-badc-1ba6abab6d66', // Azure SQL Database
  'fc780465-2017-40d4-a0c5-307022471b92', // Microsoft Defender for Endpoint
  '8ee8fdad-f234-4243-8f3b-15c294843740', // Microsoft 365 Defender
  '05a65629-4c1b-48c1-a78b-804c4abdd4af', // Microsoft Defender for Cloud Apps
  'c5393580-f805-4401-95e8-94b7a6ef2fc2', // Office 365 Management APIs
  '48ac35b8-9aa8-4d74-927d-1f4a14a0b239', // Skype and Teams Tenant Admin API
  'cc15fd57-2c6c-4117-a88c-83b1d56b4bbe', // Microsoft Teams Services
  'c161e42e-d4df-4a3d-9b42-e7a3c31f59d4', // Microsoft Intune API
  '499b84ac-1321-427f-aa17-267ca6975798', // Azure DevOps
  'f5c26e74-f226-4ae8-85f0-b4af0080ac9e', // Application Insights API
  '2746ea77-4702-4b45-80ca-3c97e680e8b7', // Azure Data Explorer
  '6dae42f8-4368-4678-94ff-3960e28e3630', // Azure Kubernetes Service AAD Server
  'ddbf3205-c6bd-46ae-8127-60eb93363864', // Azure Batch
  'fa3d9a0c-3fb0-42cc-9193-47c7ecd2edbd', // Microsoft Partner Center
  '2d4d3d8e-2be3-4bef-9f87-7875a61c29de', // OneNote
]);
/** Graph, Azure AD Graph, Dynamics CRM, Power BI, Intune, Azure RMS… and Exchange, SharePoint, Skype, Yammer… */
const MICROSOFT_APP_ID_FAMILIES = /^[0-9a-f]{8}-0000-(0000-c000|0ff1-ce00)-000000000000$/i;
/** Audiences of Entra's own token exchange (workload identity federation): never requested for a connection. */
const MICROSOFT_API_URIS = new Set(['api://azureadtokenexchange']);

const stripDot = (host: string) => host.replace(/\.+$/, '').toLowerCase();

const isMicrosoftAppId = (id: string) =>
  MICROSOFT_RESOURCE_APP_IDS.has(id.toLowerCase()) || MICROSOFT_APP_ID_FAMILIES.test(id);

/** A Microsoft first-party resource (by host, well-known application id or token-exchange URI). */
export function isMicrosoftResource(audience: string): boolean {
  const a = audience.trim().replace(/\/+$/, '');
  if (GUID.test(a)) return isMicrosoftAppId(a);
  if (/^api:\/\//i.test(a)) {
    if (MICROSOFT_API_URIS.has(a.toLowerCase())) return true;
    const first = a.slice('api://'.length).split('/')[0] ?? '';
    return GUID.test(first) && isMicrosoftAppId(first);
  }
  if (!/^https?:\/\//i.test(a)) return false;
  try {
    return MICROSOFT_RESOURCE_HOSTS.test(stripDot(new URL(a).hostname));
  } catch {
    return true;
  }
}

/** AF_CONNECTION_AUDIENCE_HOSTS → normalised host names (lower case, no trailing dot). */
export const audienceHostList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .map(stripDot)
    .filter(Boolean);

export type AudienceProblem = 'microsoft' | 'not_listed' | 'invalid';

/**
 * Allow-list for connection audiences (a token for it is sent to the connection's own host): `api://…` app ID URIs,
 * application ids, and https URIs on hosts an administrator listed in AF_CONNECTION_AUDIENCE_HOSTS. Microsoft
 * first-party audiences are refused even when listed. Undefined = allowed.
 */
export function connectionAudienceProblem(
  audience: string,
  allowedHosts: readonly string[],
): AudienceProblem | undefined {
  const a = audience.trim().replace(/\/+$/, '');
  if (!a || /\s/.test(a) || hasControlChars(a)) return 'invalid';
  if (isMicrosoftResource(a)) return 'microsoft';
  if (GUID.test(a)) return undefined;
  if (/^api:\/\/[^/\s]+(\/[^\s]*)?$/i.test(a)) return undefined;
  if (!/^https:\/\//i.test(a)) return 'invalid';
  let host: string;
  try {
    const url = new URL(a);
    if (url.username || url.password) return 'invalid';
    host = stripDot(url.hostname);
  } catch {
    return 'invalid';
  }
  return allowedHosts.includes(host) ? undefined : 'not_listed';
}

/** Scope names on the connection's own audience (never a full scope URI). */
const SCOPE_NAME = /^[A-Za-z0-9._-]+$/;

// ── Errors ────────────────────────────────────────────────────────────────────

/** Refused by the request policy (ADR-003). Never retried. */
export class PolicyDenied extends AppError {
  constructor(reason: string) {
    // The policy's "Arm write access to continue." becomes the hint, so the next step is said once.
    const needsArm = /\s*Arm write access to continue\.$/;
    super(403, 'policy_denied', reason.replace(needsArm, ''), {
      hint: needsArm.test(reason) ? 'Arm write access, then run it from a published playbook.' : undefined,
    });
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
    /** A written message replacing Microsoft's (default: Microsoft's, never as raw JSON). */
    message?: string,
  ) {
    super(base.status, base.code, message ?? readableMessage(base.message), base.requestId, base.claims);
    this.name = 'OutboundError';
  }
}

const UNREADABLE = 'Microsoft returned an error without a readable description.';

/**
 * Microsoft's error text for people: some services (the Microsoft 365 usage reports) put a whole JSON error body into
 * `error.message`. The innermost `message` is used then; JSON is never shown as-is.
 */
export function readableMessage(message: string): string {
  let text = message.trim();
  for (let depth = 0; depth < 4 && /^[[{]/.test(text); depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return UNREADABLE;
    }
    const e = parsed as { error?: { message?: unknown } | string; message?: unknown } | null;
    const inner =
      typeof e?.error === 'object' && e.error && typeof e.error.message === 'string'
        ? e.error.message
        : typeof e?.message === 'string'
          ? e.message
          : undefined;
    if (!inner?.trim()) return UNREADABLE;
    text = inner.trim();
  }
  return /^[[{]/.test(text) ? UNREADABLE : text || UNREADABLE;
}

/** Microsoft 365 usage reports answer 404 UnknownTenantId (often wrapped as JSON text) without Microsoft 365. */
const isUnknownTenant = (err: ApiError) =>
  err.status === 404 && (/^UnknownTenantId$/i.test(err.code) || /\bUnknownTenantId\b/.test(err.message));

/** The message for a 404 UnknownTenantId from the usage reports (Microsoft's own text is a JSON blob). */
export const USAGE_REPORTS_UNAVAILABLE =
  'Microsoft 365 usage reports aren’t available: this tenant has no Microsoft 365 subscription, or usage data hasn’t been collected yet (it appears 24–48 hours after activity).';

/** Response mapping for anything the executor throws (OutboundError keeps its hint). */
export function outboundAppError(err: unknown): AppError {
  if (err instanceof OutboundError) {
    const s = err.status;
    const [status, code] = err.licence
      ? [403, 'licence_required']
      : err.code === RESPONSE_TOO_LARGE
        ? [502, 'response_too_large']
        : s === 401 || s === 403
          ? [403, 'upstream_forbidden']
          : s === 404
            ? [404, 'upstream_not_found']
            : s === 429
              ? [429, 'throttled']
              : s === 400
                ? [400, 'upstream_bad_request']
                : s === 0
                  ? [504, 'upstream_unreachable']
                  : [502, 'upstream_error'];
    return new AppError(status as number, code as string, err.message, { hint: err.hint });
  }
  return toAppError(err);
}

/**
 * Microsoft Defender XDR (Graph `security/incidents`, `alerts_v2`, `runHuntingQuery`) answers 403 "Account is not
 * provisioned" until the tenant's Defender data exists — also in a licensed tenant, until a Global or Security
 * Administrator first opens the Defender portal. `$filter` syntax is still checked first (400 before this 403).
 */
const isDefenderNotProvisioned = (err: ApiError) =>
  (err.status === 401 || err.status === 403) && /\baccount is not provisioned\b/i.test(err.message);

/** The message for Defender XDR's "Account is not provisioned" (probes report it as `not_configured`). */
export const DEFENDER_NOT_PROVISIONED =
  'Microsoft Defender XDR isn’t set up for this tenant yet, so there are no incidents, alerts or advanced hunting data to read.';

/**
 * Graph's Teams APIs (`/teams`, `/teams/{id}`, channels) answer delegated calls only for people who hold a Microsoft
 * Teams licence themselves: "Failed to get license information for the user. Ensure user has a valid Office365
 * license assigned to them." The tenant is licensed; the signed-in person isn't.
 */
const isUserNotLicensed = (err: ApiError) =>
  err.status >= 400 &&
  err.status < 500 &&
  /license information for the user|ensure (?:the )?user has a valid [\w\s]{0,40}licen[cs]e/i.test(
    err.message,
  );

/** The message for a call Microsoft answers only for licensed people (Teams Graph APIs). */
export const USER_NOT_LICENSED =
  'Microsoft answers this only for people who hold a licence for the service themselves, and your account has none.';

const LICENCE_CODES =
  /AadPremiumLicenseRequired|RequestFromNonPremiumTenant|NotLicensed|LicenseNotFound|Tenant_?License/i;
const LICENCE_TEXT =
  /licen[cs]e|subscription (?:is )?required|premium|\bP[12]\b|sku|not provisioned|tenant does not have/i;

/** The hint for a failed call: missing scopes, roles or licences for 401/403, throttling/temporary failures otherwise. */
export function errorHint(
  err: ApiError,
  service: ServiceId,
  identity: Pick<ExecutionIdentity, 'kind' | 'mode'>,
  requires?: Requires,
  connection?: string,
): { hint: string; licence: boolean; message?: string } {
  const ref = err.requestId ? ` Microsoft request-id ${err.requestId}.` : '';
  if (err.code === RESPONSE_TOO_LARGE)
    return {
      hint: 'Narrow it down (filters, fewer columns, a shorter time range or a smaller page) so the result is smaller. A portal administrator can raise OUTBOUND_MAX_BYTES.',
      licence: false,
    };
  if (isDefenderNotProvisioned(err))
    return {
      hint: `A Global Administrator or Security Administrator opens the Microsoft Defender portal (security.microsoft.com) once; Microsoft then sets up the tenant's Defender data, which can take a few hours. Without a Defender licence (Microsoft 365 E5, Office 365 E5, Defender for Office 365 Plan 2 or Defender for Endpoint) it isn't available.${ref}`,
      licence: false,
      message: DEFENDER_NOT_PROVISIONED,
    };
  if (service === 'graph' && isUserNotLicensed(err))
    return {
      hint:
        identity.kind === 'automation'
          ? `Microsoft treated the automation identity as an unlicensed user; check that the call uses its application permissions.${ref}`
          : `Ask your licensing admin to assign you a licence that includes the service (for teams and channels: Microsoft Teams, e.g. Office 365 E3 or E5). Other pages are unaffected.${ref}`,
      licence: false,
      message: USER_NOT_LICENSED,
    };
  const licence =
    ((err.status === 401 || err.status === 403 || err.status === 400) &&
      (LICENCE_CODES.test(err.code) || LICENCE_TEXT.test(err.message))) ||
    // Microsoft 365 usage reports answer 404 UnknownTenantId for tenants without Microsoft 365 workloads.
    isUnknownTenant(err);
  if (licence) {
    const need = requires?.licences?.length ? ` It requires ${requires.licences.join(' or ')}.` : '';
    if (isUnknownTenant(err))
      return {
        hint: `Microsoft starts the usage reports 24–48 hours after a tenant's first Microsoft 365 subscription and activity, so a newly licensed tenant sees this for a day or two; try again later. Without a Microsoft 365 subscription they never appear.${need}${ref}`,
        licence: true,
        message: USAGE_REPORTS_UNAVAILABLE,
      };
    return { hint: `Your tenant's licences don't include this feature.${need}${ref}`, licence: true };
  }
  if (err.status === 401 || err.status === 403) {
    const scopes =
      service === 'function'
        ? connection
          ? requires?.scopes?.connections?.[connection]
          : undefined
        : (requires?.scopes as Record<string, string[] | undefined> | undefined)?.[service];
    const parts: string[] = [];
    if (service === 'arm') {
      const roles = requires?.azureRoles?.length ? requires.azureRoles.join(' or ') : 'Reader';
      parts.push(
        identity.kind === 'automation'
          ? `The automation identity needs the Azure role ${roles} on the target scope.`
          : `Needs the Azure role ${roles} on the target scope (your account's Azure RBAC).`,
      );
    } else if (identity.kind === 'automation') {
      parts.push(
        scopes?.length
          ? `The automation identity needs the application permission ${scopes.join(', ')} (check with adminforge validate --scopes).`
          : 'The automation identity lacks an application permission for this call (check with adminforge validate --scopes).',
      );
    } else {
      const app = identity.mode === 'write' ? 'Write' : 'Read';
      parts.push(
        scopes?.length
          ? `Needs ${scopes.join(', ')} consented to the AdminForge ${app} app.`
          : `The AdminForge ${app} app or your account lacks permission for this call.`,
      );
    }
    if (identity.kind === 'delegated' && requires?.entraRoles?.length)
      parts.push(
        `You also need an Entra role such as ${requires.entraRoles.join(' or ')} — activate it in PIM if you are eligible.`,
      );
    return { hint: `${parts.join(' ')}${ref}`, licence: false };
  }
  if (err.status === 404)
    return {
      hint: `Not found: the object may have been deleted, or the feature is not available in this tenant.${ref}`,
      licence: false,
    };
  if (err.status === 429)
    return { hint: `Microsoft throttled this request. Try again in a minute.${ref}`, licence: false };
  if (err.status === 400)
    return {
      hint: `Microsoft rejected the request; check the filter and search values.${ref}`,
      licence: false,
    };
  if (err.status === 0)
    return {
      hint: 'Could not reach the service (network problem or timeout). Try again shortly.',
      licence: false,
    };
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
    const d = safeDecode(seg)
      .replace(/\('([^']*)'\)/g, "('{id}')")
      .replace(/=\s*'[^']*'/g, "='{id}'");
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
    for (let i = p + 3; i < out.length; i += 2)
      if (!out[i]!.startsWith('{') && out[i] && out[i - 1]!.toLowerCase() !== 'config') out[i] = '{name}';
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
      throw new AppError(
        400,
        'invalid_cursor',
        'The paging cursor is not valid for this data. Reload the list.',
      );
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
  /** Waits for a slot: until `signal` aborts, or at most `waitMs` (then rejects with outbound_busy). */
  async acquire(signal?: AbortSignal, waitMs?: number): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = () => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
      };
      const grant = () => {
        leave();
        this.active++;
        resolve();
      };
      const onAbort = () => {
        leave();
        reject(signal!.reason ?? new Error('aborted'));
      };
      this.queue.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (waitMs)
        timer = setTimeout(() => {
          leave();
          reject(outboundBusy());
        }, waitMs);
    });
  }
  release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

/** 503 outbound_busy: every slot for Microsoft calls stayed taken for OUTBOUND_QUEUE_WAIT_MS. */
export const outboundBusy = () =>
  new AppError(503, 'outbound_busy', 'AdminForge is handling too many Microsoft requests right now.', {
    hint: 'Try again in a moment. If it keeps happening, tell a Portal Admin: the outbound limits may be too low for the load.',
  });

/**
 * What an attempt is for: `interactive` — one page of a list, an entity read, a `$batch`, a write, the first
 * CRAWL_AFTER_PAGES pages of a `paging: all` — is served first; `crawl` — the pages after those — may use only
 * OUTBOUND_CRAWL_SHARE of a service's slots, so a dashboard that crawls a whole collection can't take every slot
 * from the people clicking through lists.
 */
export type Lane = 'interactive' | 'crawl';

/** Pages of a `paging: all` served as interactive work before the rest of it counts as a crawl. */
export const CRAWL_AFTER_PAGES = 2;

/** One service's slots: interactive waiters go first, crawls never hold more than `crawlMax`. */
class Pool {
  active = 0;
  crawlActive = 0;
  private readonly waiting: Record<Lane, Array<() => void>> = { interactive: [], crawl: [] };
  constructor(
    readonly max: number,
    readonly crawlMax: number,
  ) {}
  get idle() {
    return this.active === 0 && !this.waiting.interactive.length && !this.waiting.crawl.length;
  }
  private free(lane: Lane) {
    if (this.active >= this.max) return false;
    if (lane === 'crawl') return this.crawlActive < this.crawlMax && !this.waiting.interactive.length;
    return true;
  }
  private take(lane: Lane) {
    this.active++;
    if (lane === 'crawl') this.crawlActive++;
  }
  /** Waits for a slot in `lane`: until `signal` aborts, or at most `waitMs` (then rejects with outbound_busy). */
  async acquire(lane: Lane, signal?: AbortSignal, waitMs?: number): Promise<void> {
    signal?.throwIfAborted();
    if (this.free(lane) && !(lane === 'interactive' && this.waiting.interactive.length)) {
      this.take(lane);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const queue = this.waiting[lane];
      const leave = () => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        const i = queue.indexOf(grant);
        if (i >= 0) queue.splice(i, 1);
      };
      const grant = () => {
        leave();
        this.take(lane);
        resolve();
      };
      const onAbort = () => {
        leave();
        reject(signal!.reason ?? new Error('aborted'));
        this.drain();
      };
      queue.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (waitMs)
        timer = setTimeout(() => {
          leave();
          reject(outboundBusy());
          this.drain();
        }, waitMs);
    });
  }
  release(lane: Lane): void {
    this.active--;
    if (lane === 'crawl') this.crawlActive--;
    this.drain();
  }
  /** Hands free slots out: interactive waiters first, then crawls within their share. */
  private drain(): void {
    while (this.waiting.interactive.length && this.free('interactive')) this.waiting.interactive[0]!();
    while (this.waiting.crawl.length && this.free('crawl')) this.waiting.crawl[0]!();
  }
}

export interface LimiterSizes {
  /** Slots per service for people (OUTBOUND_CONCURRENCY). */
  perService: number;
  /** Slots per person (or the automation identity) per service (OUTBOUND_USER_CONCURRENCY). */
  perIdentity: number;
  /** Share of a service's slots crawls may hold (OUTBOUND_CRAWL_SHARE). */
  crawlShare: number;
  /** Slots per service for the automation identity, apart from people's (OUTBOUND_AUTOMATION_CONCURRENCY). */
  automation: number;
}

/**
 * Concurrency for Microsoft calls, per attempt: a slot per identity per service, then one of the service's slots —
 * people share a pool with lanes (Pool), the automation identity (schedules, probes) has its own pool, so neither
 * starves the other.
 */
class Limiter {
  private readonly sems = new Map<string, Semaphore>();
  private readonly pools = new Map<string, Pool>();
  constructor(private readonly sizes: LimiterSizes) {}
  private sem(key: string, max: number) {
    let s = this.sems.get(key);
    if (!s) this.sems.set(key, (s = new Semaphore(max)));
    return s;
  }
  private pool(service: ServiceId, automation: boolean) {
    const key = automation ? `${service}:automation` : service;
    let p = this.pools.get(key);
    if (!p) {
      const max = automation ? this.sizes.automation : this.sizes.perService;
      const crawlMax = automation ? max : Math.max(1, Math.floor(max * this.sizes.crawlShare));
      this.pools.set(key, (p = new Pool(max, crawlMax)));
    }
    return p;
  }
  /**
   * Identity slot first, then the service slot (waiting for one never holds the other). `waitMs` bounds the wait for
   * both together.
   */
  async run<T>(
    service: ServiceId,
    identity: string,
    fn: () => Promise<T>,
    opts: { signal?: AbortSignal; waitMs?: number; lane?: Lane } = {},
  ): Promise<T> {
    const { signal, waitMs } = opts;
    const lane = opts.lane ?? 'interactive';
    const userKey = `${service}:${identity}`;
    const user = this.sem(userKey, this.sizes.perIdentity);
    const started = Date.now();
    try {
      await user.acquire(signal, waitMs);
    } catch (err) {
      if (user.idle) this.sems.delete(userKey);
      throw err;
    }
    const pool = this.pool(service, identity === 'automation');
    try {
      await pool.acquire(lane, signal, waitMs ? Math.max(1, waitMs - (Date.now() - started)) : undefined);
      try {
        return await fn();
      } finally {
        pool.release(lane);
      }
    } finally {
      user.release();
      if (user.idle) this.sems.delete(userKey);
    }
  }
  /** Attempts in flight for a service (both pools) or an identity key (tests/metrics). */
  activeFor(key: string) {
    return (
      this.sems.get(key)?.active ??
      (this.pools.get(key)?.active ?? 0) + (this.pools.get(`${key}:automation`)?.active ?? 0)
    );
  }
  /** Crawl attempts in flight for a service (tests/metrics). */
  crawlsFor(service: ServiceId) {
    return this.pools.get(service)?.crawlActive ?? 0;
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
function normaliseBatch(
  body: unknown,
  beta: boolean | undefined,
): { wire: { requests: Array<Record<string, unknown>> }; items: BatchItem[] } {
  const requests = (body as { requests?: unknown } | undefined)?.requests;
  if (!Array.isArray(requests) || requests.length === 0)
    throw new AppError(400, 'invalid_request', '$batch needs a non-empty requests array.');
  const items: BatchItem[] = requests.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : String(i + 1);
    const method = typeof r.method === 'string' ? r.method.toUpperCase() : 'GET';
    const headers = r.headers as Record<string, string> | undefined;
    const itemBeta = typeof r.beta === 'boolean' ? r.beta : beta;
    // Checked before parsing: the URL parser would silently drop control characters and resolve `..` segments.
    const target = typeof r.url === 'string' ? r.url : typeof r.path === 'string' ? r.path : undefined;
    if (
      target !== undefined &&
      (hasControlChars(target) || cleanPath(target.startsWith('/') ? target : `/${target}`) === undefined)
    )
      throw new AppError(
        400,
        'invalid_request',
        `$batch request ${describePath(id)} has a path that isn't a clean service path (${describePath(target)}).`,
      );
    if (typeof r.url === 'string') {
      const u = new URL(`https://graph.invalid${r.url.startsWith('/') ? '' : '/'}${r.url}`);
      const query: Record<string, string> = {};
      for (const [k, v] of u.searchParams) query[k] = v;
      return {
        id,
        method,
        path: u.pathname.replace(/^\/(v1\.0|beta)(?=\/)/, ''),
        query,
        headers,
        body: r.body,
        beta: itemBeta,
      };
    }
    if (typeof r.path !== 'string')
      throw new AppError(400, 'invalid_request', `$batch request ${id} needs a url or a path.`);
    return {
      id,
      method,
      path: r.path,
      query: r.query as BatchItem['query'],
      headers,
      body: r.body,
      beta: itemBeta,
    };
  });
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw new AppError(400, 'invalid_request', '$batch request ids must be unique.');
  const wire = {
    requests: items.map((i) => {
      let url: string;
      try {
        url = buildUrl('', { path: i.path, query: i.query }).replace(/^\/(v1\.0|beta)/, '');
      } catch {
        url = i.path;
      }
      return {
        id: i.id,
        method: i.method ?? 'GET',
        url,
        ...(i.headers ? { headers: i.headers } : {}),
        ...(i.body !== undefined ? { body: i.body } : {}),
      };
    }),
  };
  return { wire, items };
}

// ── What is actually sent ───────────────────────────────────────────────────

/**
 * The path as the service will receive it: the URL the connector builds, parsed the way fetch parses it. Throws
 * PolicyDenied when parsing leaves the service's origin or path prefix (it never should for a clean path).
 */
export function sentPath(
  service: ServiceId,
  method: string,
  path: string,
  call: Pick<ServiceCall, 'beta'>,
  fn?: { connection: { baseUrl: string } },
): string {
  let base: string;
  let prefix = '';
  switch (service) {
    case 'graph':
      base = GRAPH_BASE;
      prefix = `/${call.beta ? 'beta' : 'v1.0'}`;
      break;
    case 'arm':
      base = ARM_BASE;
      break;
    case 'logAnalytics':
      base = LOG_ANALYTICS_BASE_URL;
      break;
    case 'function':
      if (!fn) return path;
      base = fn.connection.baseUrl.replace(/\/+$/, '');
      break;
    default:
      return path;
  }
  const refuse = () =>
    new PolicyDenied(`Refusing ${method} ${describePath(path)}: not a clean service path.`);
  if (hasControlChars(path)) throw refuse();
  let expected: URL;
  let url: URL;
  try {
    expected = new URL(`${base}${prefix}`);
    url = new URL(`${base}${prefix}${path}`);
  } catch {
    throw refuse();
  }
  const root = expected.pathname.replace(/\/+$/, '');
  if (url.origin !== expected.origin || !url.pathname.startsWith(`${root}/`) || url.search || url.hash)
    throw refuse();
  return url.pathname.slice(root.length);
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
  if (typeof out !== 'string' || !out)
    throw new AppError(503, 'connection_not_configured', `The connection's ${what} is not configured.`, {
      hint: 'Set the env key it references in the AdminForge env file.',
    });
  return out;
};

// ── The executor ────────────────────────────────────────────────────────────

const identityKey = (identity: ExecutionIdentity) =>
  identity.kind === 'automation' ? 'automation' : identity.session.userOid;

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
  /** Retries of this call (telemetry). */
  stats: { retries: number; throttledRetries: number };
}

interface Dispatched {
  data: unknown;
  status: number;
  requestId?: string;
  nextCursor?: string;
  /** Provenance path when it differs from the default template. */
  path?: string;
  /** Part of the result only (see ServiceCallResult.truncated). */
  truncated?: boolean;
}

export class Outbound implements OutboundExecutor {
  private readonly limiter: Limiter;
  private readonly cursors: CursorSeal;
  private readonly now: () => Date;
  /** The protected-object guard for declared writes (its directory reads go through this executor). */
  readonly protectedObjects: ProtectedObjects;

  constructor(private readonly deps: OutboundDeps) {
    this.limiter = new Limiter({
      perService: deps.config.OUTBOUND_CONCURRENCY,
      perIdentity: deps.config.OUTBOUND_USER_CONCURRENCY,
      crawlShare: deps.config.OUTBOUND_CRAWL_SHARE ?? 0.5,
      automation: deps.config.OUTBOUND_AUTOMATION_CONCURRENCY ?? 8,
    });
    this.cursors = new CursorSeal(deps.config.TOKEN_CACHE_KEY);
    this.now = deps.now ?? (() => new Date());
    this.protectedObjects = new ProtectedObjects({
      config: deps.config,
      automation: deps.config.DATA_MODE === 'fixtures' || deps.automation !== null,
      now: this.now,
      ...(deps.protectedTtlMs !== undefined ? { ttlMs: deps.protectedTtlMs } : {}),
      read: async (who, path, query, o) => {
        try {
          const res = await this.execute(
            who,
            {
              service: 'graph',
              method: 'GET',
              path,
              query,
              paging: o.all ? 'all' : 'none',
              maxItems: MAX_ITEMS,
            },
            { correlationId: o.correlationId },
          );
          return res.data;
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        }
      },
    });
  }

  /** In-flight attempts for a service (tests/metrics). */
  active(service: ServiceId): number {
    return this.limiter.activeFor(service);
  }

  /**
   * The concurrency slot for each attempt of one call by `identity` on `service`. A person's first attempt of a read
   * waits at most OUTBOUND_QUEUE_WAIT_MS (then 503 outbound_busy — nothing has been sent yet). Declared writes and
   * every later attempt (retries, further pages, polls of a long-running operation) wait as long as it takes: once
   * something reached Microsoft, being busy must never turn into "try again". The automation identity always waits
   * (schedules have their own timeouts).
   */
  gate(
    identity: ExecutionIdentity,
    service: ServiceId,
    signal?: AbortSignal,
    opts: { lane?: Lane; write?: boolean; crawlAfter?: number } = {},
  ): Gate {
    const capped =
      identity.kind === 'delegated' && !opts.write
        ? (this.deps.config.OUTBOUND_QUEUE_WAIT_MS ?? 15_000) || undefined
        : undefined;
    let attempts = 0;
    return (attempt) => {
      const n = attempts++;
      // `crawlAfter`: the first attempts of a `paging: all` are interactive (a user's groups fit in a page or two);
      // only a call that keeps going becomes a crawl.
      const lane =
        opts.lane ?? (opts.crawlAfter !== undefined && n >= opts.crawlAfter ? 'crawl' : 'interactive');
      return this.limiter.run(service, identityKey(identity), attempt, {
        signal,
        waitMs: n === 0 ? capped : undefined,
        lane,
      });
    };
  }

  /** Crawl attempts in flight for a service (tests/metrics). */
  crawls(service: ServiceId): number {
    return this.limiter.crawlsFor(service);
  }

  /** The emergency stop and the protected-object guard for writes sent elsewhere (the PowerShell runner). */
  async assertWritable(identity: ExecutionIdentity, targets: WriteTarget[], correlationId?: string) {
    if (await this.deps.writesPaused?.()) throw writesPausedError();
    await this.protectedObjects.check(identity, targets, correlationId);
  }

  async execute<T = unknown>(
    identity: ExecutionIdentity,
    call: ServiceCall,
    opts: { correlationId?: string; signal?: AbortSignal } = {},
  ): Promise<ServiceCallResult<T>> {
    const service = call.service;
    if (PS_SERVICES.has(service))
      throw new AppError(
        501,
        'not_supported',
        `${service} work runs through the PowerShell runner, not as a REST call.`,
      );
    const correlationId = opts.correlationId ?? randomUUID();
    const declaredWrite = call.declaredWrite === true;
    // Emergency stop: nothing declared as a write leaves while changes are paused (reads keep working). AdminForge's
    // own notification mail still goes out, so approvers and report recipients hear what's happening.
    const notification =
      call.notification === true &&
      identity.kind === 'automation' &&
      /^\/users\/[^/]+\/sendMail$/.test(call.path);
    if (declaredWrite && !notification && (await this.deps.writesPaused?.())) throw writesPausedError();

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
      declaredWrite,
      declaredRead: fn ? fn.mode === 'read' : call.declaredRead === true,
    });
    if (!decision.allowed) throw new PolicyDenied(decision.reason);
    // The policy must judge what is actually sent: fetch's URL parser can still rewrite a path (it drops TAB/LF/CR and
    // then resolves dot segments). Parse the URL the connector will build and check it again.
    const sent = sentPath(service, method, path, call, fn);
    if (sent !== path) {
      const again = evaluate(identity.mode, {
        service,
        method,
        path: sent,
        body,
        declaredWrite,
        declaredRead: fn ? fn.mode === 'read' : call.declaredRead === true,
      });
      if (!again.allowed) throw new PolicyDenied(again.reason);
    }
    // Protected objects: what the write would change, as sent (each changing $batch sub-request on its own).
    if (declaredWrite) {
      const targets: WriteTarget[] = batch
        ? batch
            .filter((i) => !SAFE_METHODS.has((i.method ?? 'GET').toUpperCase()))
            .map((i) => ({ service, method: i.method ?? 'GET', path: i.path, query: i.query, body: i.body }))
        : SAFE_METHODS.has(method)
          ? []
          : [{ service, method, path: sent, query: call.query, body }];
      await this.protectedObjects.check(identity, targets, correlationId);
    }

    const template = call.pathTemplate ?? fn?.template ?? templatePath(path);
    const sensitive = service === 'arm' && method === 'POST' && APP_SETTINGS_LIST.test(path);
    const started = performance.now();
    const stats = { retries: 0, throttledRetries: 0 };
    try {
      // Concurrency slots are taken per attempt inside the connectors (`gate`), not for the whole call.
      const out = await this.withToken(identity, service, fn, (getToken) =>
        this.dispatch({
          identity,
          call,
          method,
          path,
          body,
          batch,
          fn,
          getToken,
          correlationId,
          signal: opts.signal,
          stats,
        }),
      );
      if (sensitive) {
        out.data = settingNamesOnly(out.data);
        const names = Object.keys(
          ((out.data as { properties?: object } | undefined)?.properties ?? {}) as object,
        ).length;
        await this.deps.onSensitiveRead?.({
          identity,
          service,
          method,
          path,
          correlationId,
          result: 'success',
          names,
        });
      }
      const provenance: Provenance = {
        service,
        path: out.path ?? template,
        ms: Math.round(performance.now() - started),
        ...(out.requestId ? { requestId: out.requestId } : {}),
        ...(service === 'graph' && call.beta ? { preview: true as const } : {}),
      };
      this.record(
        identity,
        service,
        method,
        template,
        out.status,
        provenance.ms,
        correlationId,
        out.requestId,
        stats,
      );
      return {
        data: out.data as T,
        status: out.status,
        provenance,
        ...(out.nextCursor ? { nextCursor: out.nextCursor } : {}),
        ...(out.truncated ? { truncated: true } : {}),
      };
    } catch (err) {
      if (sensitive)
        await Promise.resolve(
          this.deps.onSensitiveRead?.({ identity, service, method, path, correlationId, result: 'failure' }),
        ).catch(() => undefined);
      if (err instanceof ApiError && !(err instanceof OutboundError)) {
        const provenance: Provenance = {
          service,
          path: template,
          ms: Math.round(performance.now() - started),
          ...(err.requestId ? { requestId: err.requestId } : {}),
        };
        this.record(
          identity,
          service,
          method,
          template,
          err.status,
          provenance.ms,
          correlationId,
          err.requestId,
          stats,
        );
        const { hint, licence, message } = errorHint(err, service, identity, call.requires, call.connection);
        throw new OutboundError(err, service, hint, licence, provenance, message);
      }
      if (
        err instanceof Error &&
        !(err instanceof AppError) &&
        !(err instanceof ReauthRequired) &&
        !(err instanceof NotArmed) &&
        /^(Invalid .* path|ARM requests need|Log Analytics|Resource Graph query|Operation ".*" needs|Connection .* has no|nextLink points|Invalid value for path)/.test(
          err.message,
        )
      ) {
        throw new AppError(400, 'invalid_request', err.message);
      }
      throw err;
    }
  }

  private record(
    identity: ExecutionIdentity,
    service: ServiceId,
    method: string,
    template: string,
    status: number,
    ms: number,
    correlationId: string,
    requestId: string | undefined,
    stats: { retries: number; throttledRetries: number },
  ) {
    if (!this.deps.onCall) return;
    try {
      this.deps.onCall({
        service,
        method,
        path: template,
        status,
        ms,
        throttled: status === 429 || stats.throttledRetries > 0,
        retries: stats.retries,
        throttledRetries: stats.throttledRetries,
        identity: identity.kind,
        mode: identity.mode,
        correlationId,
        ...(requestId ? { requestId } : {}),
      });
    } catch {
      /* telemetry never breaks a call */
    }
  }

  // ── Tokens ──

  private async withToken<T>(
    identity: ExecutionIdentity,
    service: ServiceId,
    fn: ResolvedFunction | undefined,
    run: (getToken: TokenProvider) => Promise<T>,
  ): Promise<T> {
    if (this.deps.config.DATA_MODE === 'fixtures') return run(async () => 'fixture-token');
    if (identity.kind === 'automation') {
      const automation = this.deps.automation;
      if (!automation)
        throw new AppError(503, 'automation_not_configured', 'The automation identity is not configured.', {
          hint: 'Set AF_AUTOMATION_CLIENT_ID and AF_AUTOMATION_CERT_PATH (or AF_AUTOMATION_CLIENT_SECRET) in the env file.',
        });
      const scope = fn
        ? appOnlyScope(fn.audience)
        : resourceScopes(this.deps.config)[service as BrokerService]?.[0];
      if (!scope)
        throw new AppError(
          503,
          'service_not_configured',
          `${service} is not configured for this installation.`,
        );
      return withClaimsRetry((claims) => run(() => automation.token(scope, claims ? { claims } : {})));
    }
    const { session, mode } = identity;
    if (fn) {
      const auth = this.deps.auth;
      if (!auth) throw liveDataUnavailable();
      return withClaimsRetry(
        (claims) => run(() => delegatedToken(auth, session, mode, fn.scopes, this.now, claims)),
        mode,
      );
    }
    const broker = this.deps.broker;
    if (!broker) throw liveDataUnavailable();
    return broker.withToken(session, service as BrokerService, mode, run);
  }

  // ── Connectors ──

  private client(d: Dispatch) {
    const slow = timeoutOverride(this.deps.config.OUTBOUND_TIMEOUT_OVERRIDES, d.call.service, d.path);
    return {
      getToken: d.getToken,
      fetch: this.deps.fetch,
      correlationId: d.correlationId,
      // Slow reads get one longer attempt; everything else one more try after a timeout.
      timeoutMs: slow?.ms ?? this.deps.config.OUTBOUND_TIMEOUT_MS,
      maxTimeoutRetries: slow ? 0 : 1,
      // A `paging: all` past its second page is a crawl and takes at most its share of the slots; a write is never
      // refused as busy. A `$batch` is one short request (the counts on a list page): interactive.
      gate: this.gate(d.identity, d.call.service, d.signal, {
        ...(d.call.paging === 'all' ? { crawlAfter: CRAWL_AFTER_PAGES } : {}),
        write: d.call.declaredWrite === true,
      }),
      ...(d.signal ? { signal: d.signal } : {}),
      onRetry: (info: RetryInfo) => {
        d.stats.retries++;
        if (info.reason === 'throttled') d.stats.throttledRetries++;
      },
      maxResponseBytes: this.deps.config.OUTBOUND_MAX_BYTES ?? DEFAULT_MAX_RESPONSE_BYTES,
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
        return d.method === 'POST' && d.path.toLowerCase() === RESOURCE_GRAPH_PATH.toLowerCase()
          ? this.resourceGraph(d)
          : this.arm(d);
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
      // A collection in a $batch answers with its first page only: say so when Graph had more.
      const truncated = d.batch.some((i) => {
        const b = out[i.id]?.body as { '@odata.nextLink'?: unknown } | undefined;
        return !!b && typeof b === 'object' && typeof b['@odata.nextLink'] === 'string';
      });
      return {
        status: 200,
        data: {
          responses: d.batch.map((i) => ({
            id: i.id,
            status: out[i.id]?.status ?? 0,
            body: out[i.id]?.body,
          })),
        },
        ...(truncated ? { truncated: true } : {}),
      };
    }
    const req: GraphRequest = {
      method: d.method,
      path: d.path,
      query: call.query,
      headers: call.headers,
      body: d.body,
      beta: call.beta,
    };
    const base = `${GRAPH_BASE}/${call.beta ? 'beta' : 'v1.0'}/`;
    const checkLink = (url: string) => {
      if (!url.startsWith(base))
        throw new AppError(
          502,
          'upstream_error',
          'Microsoft Graph returned a nextLink outside Graph; refusing to follow it.',
        );
      return url;
    };
    const paging = call.paging ?? 'none';
    if (paging === 'all') {
      const max = this.maxItems(call);
      const value: unknown[] = [];
      let url: string | undefined = buildUrl(GRAPH_BASE, req);
      let first: { status: number; requestId?: string; count?: unknown } | undefined;
      for (let page = 0; url && value.length < max && page < MAX_PAGES; page++) {
        const r: {
          data: { value?: unknown[]; '@odata.nextLink'?: string; '@odata.count'?: unknown };
          status: number;
          requestId?: string;
        } = await client.request(req, url);
        first ??= { status: r.status, requestId: r.requestId, count: r.data?.['@odata.count'] };
        value.push(...(r.data?.value ?? []));
        url = r.data?.['@odata.nextLink'];
        if (url) checkLink(url);
      }
      // More pages left (maxItems or the page limit reached first), or the last page went past maxItems.
      const truncated = value.length > max || !!url;
      return {
        status: first?.status ?? 200,
        requestId: first?.requestId,
        data: {
          value: value.slice(0, max),
          ...(first?.count !== undefined ? { '@odata.count': first.count } : {}),
          ...(truncated ? { truncated: true } : {}),
        },
        ...(truncated ? { truncated: true } : {}),
      };
    }
    let url: string;
    if (typeof paging === 'object' && paging.cursor)
      url = checkLink(this.cursors.open(this.binding(d), paging.cursor));
    else {
      const query: Query = { ...call.query };
      if (typeof paging === 'object' && paging.pageSize && query.$top === undefined)
        query.$top = paging.pageSize;
      url = buildUrl(GRAPH_BASE, { ...req, query });
    }
    const r = await client.request<Record<string, unknown> | undefined>(req, url);
    if (typeof paging === 'object' && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
      const { '@odata.nextLink': next, ...rest } = r.data;
      return {
        status: r.status,
        requestId: r.requestId,
        data: rest,
        ...(typeof next === 'string'
          ? { nextCursor: this.cursors.seal(this.binding(d), checkLink(next)) }
          : {}),
      };
    }
    return { status: r.status, requestId: r.requestId, data: r.data };
  }

  private async arm(d: Dispatch): Promise<Dispatched> {
    const { call } = d;
    if (!call.apiVersion)
      throw new AppError(
        400,
        'invalid_request',
        `ARM calls need an apiVersion (${d.method} ${templatePath(d.path)}).`,
      );
    const client = createArmClient({
      ...this.client(d),
      ...(call.pollTimeoutMs ? { maxPollMs: call.pollTimeoutMs } : {}),
    });
    const req = {
      method: d.method,
      path: d.path,
      apiVersion: call.apiVersion,
      query: call.query,
      headers: call.headers,
      body: d.body,
    };
    const checkLink = (url: string) => {
      if (!url.startsWith(`${ARM_BASE}/`))
        throw new AppError(
          502,
          'upstream_error',
          'Azure Resource Manager returned a nextLink outside ARM; refusing to follow it.',
        );
      return url;
    };
    const paging = call.paging ?? 'none';
    if (paging === 'all') {
      const max = this.maxItems(call);
      const value: unknown[] = [];
      let first: { status: number; requestId?: string } | undefined;
      let pages = 0;
      for await (const page of client.pages(req, MAX_PAGES)) {
        first ??= { status: 200 };
        pages++;
        value.push(...page);
        if (value.length >= max) break;
      }
      // ARM's pager hides nextLink: reaching maxItems (or the page limit) means there may be more.
      const truncated = value.length >= max || pages >= MAX_PAGES;
      return {
        status: first?.status ?? 200,
        data: { value: value.slice(0, max), ...(truncated ? { truncated: true } : {}) },
        ...(truncated ? { truncated: true } : {}),
      };
    }
    if (typeof paging === 'object') {
      const r = paging.cursor
        ? await client.request<Record<string, unknown> | undefined>(
            req,
            checkLink(this.cursors.open(this.binding(d), paging.cursor)),
          )
        : await client.request<Record<string, unknown> | undefined>(req);
      const { nextLink, ...rest } = (r.data ?? {}) as Record<string, unknown>;
      return {
        status: r.status,
        requestId: r.requestId,
        data: rest,
        ...(typeof nextLink === 'string' && nextLink
          ? { nextCursor: this.cursors.seal(this.binding(d), checkLink(nextLink)) }
          : {}),
      };
    }
    const write = d.method !== 'GET' && d.method !== 'HEAD';
    const r = write && call.poll !== false ? await client.requestAndWait(req) : await client.request(req);
    return { status: r.status, requestId: r.requestId, data: r.data };
  }

  private async resourceGraph(d: Dispatch): Promise<Dispatched> {
    const { call } = d;
    const b = (d.body ?? {}) as { query?: string; subscriptions?: string[]; managementGroups?: string[] };
    if (typeof b.query !== 'string' || !b.query.trim())
      throw new AppError(400, 'invalid_request', 'Resource Graph calls need a query.');
    const rg = createResourceGraphClient({
      ...this.client(d),
      apiVersion: call.apiVersion ?? RESOURCE_GRAPH_API_VERSION,
    });
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
      const kept = Math.min(value.length, max);
      const truncated = (first?.totalRecords ?? value.length) > kept;
      return {
        status: 200,
        requestId: first?.requestId,
        data: {
          value: value.slice(0, max),
          totalRecords: first?.totalRecords ?? value.length,
          ...(truncated ? { truncated: true } : {}),
        },
        ...(truncated ? { truncated: true } : {}),
      };
    }
    const cursor = typeof paging === 'object' ? paging : undefined;
    const page = await rg.query({
      ...q,
      top: cursor?.pageSize,
      skipToken: cursor?.cursor ? this.cursors.open(binding, cursor.cursor) : undefined,
    });
    return {
      status: 200,
      requestId: page.requestId,
      data: {
        value: page.rows,
        totalRecords: page.totalRecords,
        count: page.count,
        resultTruncated: page.resultTruncated ?? false,
      },
      ...(cursor && page.skipToken ? { nextCursor: this.cursors.seal(binding, page.skipToken) } : {}),
    };
  }

  private async logAnalytics(d: Dispatch): Promise<Dispatched> {
    const m = /^\/v1\/workspaces\/([^/]+)\/query$/i.exec(d.path);
    if (!m)
      throw new AppError(
        400,
        'invalid_request',
        'Log Analytics calls must POST /v1/workspaces/{workspaceId}/query.',
      );
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
    const r = await client.call(fn.operation, {
      pathParams: d.call.pathParams,
      query: d.call.query,
      headers: d.call.headers,
      body: d.body,
    });
    return { status: r.status, requestId: r.requestId, data: r.data };
  }

  private async resolveFunction(call: ServiceCall): Promise<ResolvedFunction> {
    if (!call.connection) throw new AppError(400, 'invalid_request', 'function calls need a connection.');
    if (!this.deps.connection)
      throw new AppError(503, 'connection_not_configured', 'Connections are not available in this process.');
    const def = await this.deps.connection(call.connection);
    const name = call.operation ?? (call.path && !call.path.startsWith('/') ? call.path : undefined);
    if (!name || !Object.hasOwn(def.operations, name))
      throw new AppError(
        400,
        'invalid_request',
        `Connection ${call.connection} has no operation "${name ?? ''}".`,
      );
    const env = this.deps.env?.() ?? {};
    const baseUrl = await asText(def.baseUrl, env, 'baseUrl');
    const audience = (await asText(def.audience, env, 'audience')).trim().replace(/\/+$/, '');
    // A token for a Microsoft service (Graph, ARM, Exchange…) sent to a connection's own host would hand that host
    // the caller's (or the automation identity's) access: connections may only target your own app registrations.
    const problem = connectionAudienceProblem(
      audience,
      audienceHostList(this.deps.config.AF_CONNECTION_AUDIENCE_HOSTS),
    );
    if (problem)
      throw new AppError(
        400,
        'connection_audience_not_allowed',
        problem === 'microsoft'
          ? `Connection ${call.connection} asks for a token for a Microsoft service, which AdminForge never sends to another host.`
          : problem === 'not_listed'
            ? `Connection ${call.connection} asks for a token for an audience on a host that isn't approved for connections.`
            : `Connection ${call.connection} has an audience AdminForge can't use.`,
        {
          hint:
            problem === 'microsoft'
              ? 'Connections call your own APIs: point the audience at your app registration (api://… or its application id). Use graph or arm steps for Microsoft services.'
              : 'Ask a portal administrator to set the audience to your app registration (api://… or its application id), or to add its host to AF_CONNECTION_AUDIENCE_HOSTS.',
        },
      );
    // Scope names only: the token is always for `<audience>/<name>`, so a scope can't name another resource.
    const names = def.scopes?.length ? def.scopes : ['user_impersonation'];
    const badScope = names.find((n) => typeof n !== 'string' || !SCOPE_NAME.test(n));
    if (badScope !== undefined)
      throw new AppError(
        400,
        'connection_scope_not_allowed',
        `Connection ${call.connection} lists a scope that isn't a plain scope name.`,
        {
          hint: 'Ask a portal administrator to list scope names only (for example user_impersonation); AdminForge adds the connection audience itself.',
        },
      );
    const operations: FunctionConnection['operations'] = {};
    for (const [k, op] of Object.entries(def.operations))
      operations[k] = {
        method: op.method,
        path: op.path,
        mode: op.mode,
        ...(op.idempotent !== undefined ? { idempotent: op.idempotent } : {}),
      };
    const connection: FunctionConnection = { id: call.connection, baseUrl, operations };
    let resolved: { method: string; path: string; mode: Mode };
    try {
      resolved = createFunctionClient({ getToken: async () => '', connection }).resolve(name, {
        pathParams: call.pathParams,
      });
    } catch (err) {
      throw new AppError(400, 'invalid_request', (err as Error).message);
    }
    const scopes = names.map((n) => `${audience}/${n}`);
    return {
      connection,
      operation: name,
      method: resolved.method,
      path: resolved.path,
      template: def.operations[name]!.path,
      mode: resolved.mode,
      audience,
      scopes,
    };
  }
}

const liveDataUnavailable = () =>
  new AppError(409, 'live_data_unavailable', 'Live data needs Entra sign-in.', {
    hint: 'Use DATA_MODE=fixtures with AUTH_MODE=mock.',
  });

/** Runs `attempt`; a 401 with a CAE claims challenge is retried once with a token minted for those claims. */
async function withClaimsRetry<T>(attempt: (claims?: string) => Promise<T>, mode?: Mode): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    const claims =
      err instanceof ApiError && err.status === 401 && err.claims
        ? decodeClaimsChallenge(err.claims)
        : undefined;
    if (!claims) throw err;
    try {
      return await attempt(claims);
    } catch (retryErr) {
      if (mode && retryErr instanceof ApiError && retryErr.status === 401 && retryErr.claims)
        throw new ReauthRequired(mode === 'write' ? 'write' : 'read', claims);
      throw retryErr;
    }
  }
}

/** Delegated token for a connection audience from the session's Read (or, armed, Write) account. */
async function delegatedToken(
  auth: AuthClient,
  session: SessionRecord,
  mode: Mode,
  scopes: string[],
  now: () => Date,
  claims?: string,
): Promise<string> {
  const extra = claims ? { claims } : {};
  if (mode === 'write') {
    if (!isArmed(session, now())) throw new NotArmed();
    return auth.token({
      kind: 'write',
      partitionKey: partitionKey('write', session.idHash),
      homeAccountId: session.writeAccountId!,
      scopes,
      ...extra,
    });
  }
  if (!session.readAccountId) throw new ReauthRequired('read', claims);
  return auth.token({
    kind: 'read',
    partitionKey: partitionKey('read', session.idHash),
    homeAccountId: session.readAccountId,
    scopes,
    ...extra,
  });
}

export function createOutboundExecutor(deps: OutboundDeps): Outbound {
  return new Outbound(deps);
}
