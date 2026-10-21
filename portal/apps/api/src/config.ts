import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ADMIN_ENV_KEYS, loadEnv } from '@adminforge/config';
import {
  IDENTITY_NAME,
  identityEnvPrefix,
  KQL_SOURCES,
  PORTAL_ROLES,
  type PortalRole,
} from '@adminforge/schemas';
import { z } from 'zod';
import { chainKeyProblems } from './audit/keys';
import { DEFAULT_TIMEOUT_OVERRIDES, TimeoutOverrideList } from './execution/timeouts';
import { workspaceRoot } from './paths';
import type { Keyring } from './security/envelope';

const ALL_ROLES = PORTAL_ROLES.join(',');

/** Comma-separated portal roles (MOCK_ROLES). */
const RoleList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(PORTAL_ROLES)).min(1, 'at least one portal role is required'));

/**
 * Comma-separated Query Studio sources this installation offers (AF_QUERY_SOURCES); unset = all of them. An
 * installation that doesn't use Microsoft Defender XDR leaves `advancedHunting` out (routes/query.ts refuses it).
 */
const QuerySourceList = z
  .string()
  .transform((s) => [
    ...new Set(
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(
    z
      .array(z.enum(KQL_SOURCES, { error: `must be ${KQL_SOURCES.join(', ')} (comma-separated)` }))
      .min(1, 'at least one Query Studio source is required'),
  );

/** Loopback interface names and addresses (mock sign-in may only listen on these). */
export const isLoopbackHost = (host: string): boolean => {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
};

/** Comma-separated object or application ids (AF_PROTECTED_APP_IDS, AF_PROTECTED_USER_IDS); empty entries ignored. */
const GuidList = z.string().refine(
  (s) =>
    s
      .split(/[\s,]+/)
      .filter(Boolean)
      .every((id) => z.guid().safeParse(id).success),
  'must be ids (GUIDs), comma-separated',
);

/** Credentials that must never be loaded with mock sign-in (Read/Write app, automation identity, runner key). */
const MOCK_FORBIDDEN_KEYS = [
  'AF_READ_CLIENT_SECRET',
  'AF_WRITE_CLIENT_SECRET',
  'AF_AUTOMATION_CLIENT_SECRET',
  'AF_AUTOMATION_CERT_PATH',
  'RUNNER_SHARED_KEY',
] as const;

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    /** Interface to bind; defaults to loopback except in production containers. */
    API_HOST: z.string().optional(),
    PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    /** Fastify trustProxy: `true`/`false`, or IPs/CIDRs/proxy-addr presets (in Kubernetes: the ingress controller's pod network). */
    TRUST_PROXY: z.string().default('loopback'),
    /** Requests per minute per signed-in session (per address before sign-in). */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    /** Requests per minute per session that the browser marks as background (polling, refetch on focus). */
    RATE_LIMIT_BACKGROUND_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    /** Requests per minute per client address, all sessions together (a corporate NAT is one address). */
    RATE_LIMIT_PER_ADDRESS_PER_MINUTE: z.coerce.number().int().min(1).default(20_000),
    /** `/auth/login` and `/auth/callback` per client address (whatever cookie comes with them). */
    RATE_LIMIT_SIGNIN_PER_ADDRESS_PER_MINUTE: z.coerce.number().int().min(1).default(300),
    /** Requests to /api and /auth without a valid session, per client address. */
    RATE_LIMIT_ANONYMOUS_PER_ADDRESS_PER_MINUTE: z.coerce.number().int().min(1).default(600),

    AUTH_MODE: z.enum(['entra', 'mock']).default('entra'),
    DATA_MODE: z.enum(['live', 'fixtures']).default('live'),
    ADMINFORGE_FIXTURES_DIR: z.string().optional(),
    WEB_DIST_DIR: z.string().optional(),
    MOCK_ROLES: RoleList.prefault(ALL_ROLES),

    /**
     * The SQLite database file (ADR-016): an absolute path on local block storage — in Kubernetes, the PersistentVolume
     * mounted at /var/lib/adminforge (portal/deploy/kubernetes). Unset = in-memory stores (mock mode, tests).
     */
    DATABASE_PATH: z.string().optional(),
    /** How long a write waits for another process's write lock (the CLI publishing, a one-shot) before failing. */
    DATABASE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
    TOKEN_CACHE_KEY: z.string().optional(),
    /**
     * Earlier token-cache keys (comma-separated, base64), still accepted for opening blobs sealed before a rotation;
     * new blobs are always sealed with TOKEN_CACHE_KEY (security/envelope.ts).
     */
    TOKEN_CACHE_PREVIOUS_KEYS: z.string().optional(),
    /**
     * The audit chain's key (S-10): 32 random bytes, base64, from the installation's Secret — never on the database
     * volume. Set, the audit log is HMAC-SHA256 from a cut-over event on (audit/keys.ts); unset, it stays SHA-256.
     */
    AUDIT_CHAIN_KEY: z.string().optional(),
    /** After a rotation of AUDIT_CHAIN_KEY: the earlier key(s), comma-separated, so the events they keyed still verify. */
    AUDIT_CHAIN_PREVIOUS_KEYS: z.string().optional(),
    /** Ids (as the audit log names them) of audit chain keys that are lost: the API may then start a new keyed part. */
    AUDIT_CHAIN_LOST_KEY_IDS: z.string().optional(),
    /** The seq of the first audit chain cut-over: it must still be there (verification, and the API's start). */
    AUDIT_CHAIN_KEYED_SINCE: z.string().optional(),
    /** Retention (days): finished runs with their steps and events, schedule history, probe results, report files. */
    RETENTION_RUN_DAYS: z.coerce.number().int().min(7).max(3650).default(180),
    RETENTION_SCHEDULE_RUN_DAYS: z.coerce.number().int().min(7).max(3650).default(180),
    RETENTION_PROBE_DAYS: z.coerce.number().int().min(7).max(3650).default(35),
    RETENTION_ARTIFACT_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    SESSION_IDLE_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(7 * 24)
      .default(12),
    WRITE_SESSION_MAX_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
    WRITE_AUTH_CONTEXT: z
      .string()
      .regex(/^c([1-9]|[1-9][0-9])$/, 'must be an authentication context id such as c1')
      .optional(),

    AF_TENANT_ID: z.guid().optional(),
    AF_PRIMARY_DOMAIN: z.string().optional(),
    AF_SUBSCRIPTION_ID: z.guid().optional(),
    AF_SPO_TENANT_NAME: z
      .string()
      .regex(/^[a-z0-9-]+$/i, 'must be the SharePoint tenant name only, e.g. contoso')
      .optional(),
    AF_ENV_LABEL: z.string().default('dev'),
    AF_READ_CLIENT_ID: z.guid().optional(),
    AF_READ_CLIENT_SECRET: z.string().optional(),
    AF_WRITE_CLIENT_ID: z.guid().optional(),
    AF_WRITE_CLIENT_SECRET: z.string().optional(),
    /**
     * Other app ids (e.g. the provisioner) whose app registration and service principal no declared write may name,
     * like the Read, Write and Automation apps (execution/protected.ts).
     */
    AF_PROTECTED_APP_IDS: GuidList.optional(),
    /** Object ids of break-glass / emergency-access accounts (and others) no declared write may name. */
    AF_PROTECTED_USER_IDS: GuidList.optional(),

    // ── Automation identity, content registry, outbound calls (definitions/datasources) ──
    /**
     * Named app identities schedules may run as (ADR-014), comma-separated lower-case names. Each one's settings are
     * AF_IDENTITY_<NAME>_CLIENT_ID and …_CERT_PATH (preferred) or …_CLIENT_SECRET (scheduleIdentities()).
     */
    AF_SCHEDULE_IDENTITIES: z.string().optional(),
    AF_AUTOMATION_CLIENT_ID: z.guid().optional(),
    AF_AUTOMATION_CLIENT_SECRET: z.string().optional(),
    /** PEM with certificate + private key; preferred over the secret. */
    AF_AUTOMATION_CERT_PATH: z.string().optional(),
    /** fs = portal/content from disk (hot reload); db = published versions in the database. Default: db in production, else fs. */
    CONTENT_SOURCE: z.enum(['fs', 'db']).optional(),
    CONTENT_DIR: z.string().optional(),
    /** Watch CONTENT_DIR and reload on change (default: on in development). */
    CONTENT_WATCH: z.stringbool().optional(),
    /**
     * Slots per Microsoft service for people's calls in one API process (lanes: execution/outbound.ts). 48: within
     * Graph's directory limit for one app in a large tenant (8,000 resource units per 10 s) when every slot is busy;
     * measured in docs/performance.md. 429s (Retry-After) remain the backstop for stricter services (Intune, reports).
     */
    OUTBOUND_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(48),
    OUTBOUND_USER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(6),
    /**
     * Share of a service's OUTBOUND_CONCURRENCY slots that crawls (`paging: all`, `$batch`) may hold at once; the rest
     * stays free for list pages and entity reads, which are served first (execution/outbound.ts, lanes).
     */
    OUTBOUND_CRAWL_SHARE: z.coerce.number().min(0.1).max(1).default(0.5),
    /** Slots per service for the automation identity (schedules, probes), apart from people's. */
    OUTBOUND_AUTOMATION_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
    OUTBOUND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
    /**
     * Longer single attempts for calls known to be slow (execution/timeouts.ts): `service=ms` or
     * `service:/path-prefix=ms`, comma-separated. A timed-out attempt is otherwise tried once more.
     */
    OUTBOUND_TIMEOUT_OVERRIDES: TimeoutOverrideList.prefault(DEFAULT_TIMEOUT_OVERRIDES),
    /**
     * Longest wait for a free outbound slot (OUTBOUND_CONCURRENCY / OUTBOUND_USER_CONCURRENCY) before a person's
     * request is refused as busy (503 outbound_busy). 0 = wait as long as it takes. Schedules always wait.
     */
    OUTBOUND_QUEUE_WAIT_MS: z.coerce.number().int().min(0).max(600_000).default(15_000),
    /**
     * Longest a page, dashboard or report datasource may take for a person (every page and retry included) before it
     * stops with 504 datasource_timeout. 0 = no limit. Exports and schedules aren't cut short.
     */
    DATASOURCE_DEADLINE_MS: z.coerce.number().int().min(0).max(1_800_000).default(120_000),
    /** Memory for cached datasource results per process, in MB (entries are also capped at 1,000). */
    DATASOURCE_CACHE_MAX_MB: z.coerce.number().int().min(1).max(16_384).default(256),
    /** Largest response body accepted from Microsoft or a connection, in bytes (streamed; larger is refused). */
    OUTBOUND_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .max(1024 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    /**
     * Hosts (comma-separated) whose https:// URIs a connection may use as its audience, e.g. api.contoso.com. api://…
     * and application ids need no entry; Microsoft first-party hosts are refused even when listed.
     */
    AF_CONNECTION_AUDIENCE_HOSTS: z.string().optional(),
    SEARCH_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(2500),
    EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
    /** Query Studio sources offered (resourceGraph, logAnalytics, advancedHunting); unset = all three. */
    AF_QUERY_SOURCES: QuerySourceList.prefault(KQL_SOURCES.join(',')),
    // PowerShell runner (apps/runner; the pod's sidecar on 127.0.0.1); both unset = PowerShell steps/datasources disabled.
    RUNNER_URL: z.url().optional(),
    RUNNER_SHARED_KEY: z.string().min(40).optional(),
    // Run jobs the API process works on at once (the API is the run worker, ADR-016). Steps mostly wait on Microsoft.
    RUN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    // Runs one person may have queued or running at once, previews included (F-08; parked runs don't count).
    RUN_MAX_OPEN_PER_USER: z.coerce.number().int().min(1).max(100).default(5),
    // Seconds a stop (SIGTERM) may take before the API logs what is still open and exits 1 (D-24). Keep it below the
    // pod's terminationGracePeriodSeconds (60 s) and above what the run worker (15 s) and the scheduler (30 s) need.
    SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(50),
    // Schedules the scheduler (in the API process, R6) runs at once.
    SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    /** Scheduled report files: <dir>/<schedule>/<timestamp>.<ext> (default ~/.local/share/adminforge/artifacts). */
    ADMINFORGE_ARTIFACTS_DIR: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const need = (key: keyof typeof env, why: string) => {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required ${why}` });
    };
    if (env.AUTH_MODE === 'entra') {
      for (const key of [
        'AF_TENANT_ID',
        'AF_READ_CLIENT_ID',
        'AF_READ_CLIENT_SECRET',
        'TOKEN_CACHE_KEY',
        'DATABASE_PATH',
      ] as const) {
        need(key, 'when AUTH_MODE=entra');
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_MODE === 'mock') {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_MODE'],
          message: 'mock auth is not allowed in production',
        });
      }
      need('DATABASE_PATH', 'in production');
      if (env.DATABASE_PATH && !path.isAbsolute(env.DATABASE_PATH))
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_PATH'],
          message: 'must be an absolute path in production (the file on the persistent volume)',
        });
      // `true` trusts X-Forwarded-For from anyone: every rate limit, address cap and audited address could be forged.
      if (env.TRUST_PROXY.trim().toLowerCase() === 'true')
        ctx.addIssue({
          code: 'custom',
          path: ['TRUST_PROXY'],
          message: 'must name the proxies (e.g. loopback, or their addresses) in production, not true',
        });
      const url = new URL(env.PUBLIC_BASE_URL);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_BASE_URL'],
          message: 'must be https in production (the session cookie is Secure)',
        });
      }
    }
    // Production hardening — HSTS, the __Host- session cookie, the checks above, content from the database — keys off
    // NODE_ENV, which defaults to development (a developer's machine). A portal other machines reach must not lose it
    // quietly: the image and the Kubernetes ConfigMap set production (tests/guards/image-node-env.test.ts), and Entra
    // sign-in refuses to start beyond loopback without it. Development against the tenant stays on this machine.
    if (env.AUTH_MODE === 'entra' && env.NODE_ENV !== 'production') {
      if (env.API_HOST !== undefined && !isLoopbackHost(env.API_HOST))
        ctx.addIssue({
          code: 'custom',
          path: ['API_HOST'],
          message:
            'listens beyond this machine (not loopback), which needs NODE_ENV=production (the container image and the Kubernetes ConfigMap set it); for development against the tenant keep API_HOST=127.0.0.1',
        });
      // Any scheme: on http the development session cookie isn't even Secure.
      if (!isLoopbackHost(new URL(env.PUBLIC_BASE_URL).hostname))
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_BASE_URL'],
          message:
            'is an address other machines reach, which needs NODE_ENV=production (HSTS, the __Host- session cookie, the production checks); for development against the tenant use http://localhost:<port>',
        });
    }
    for (const prev of (env.TOKEN_CACHE_PREVIOUS_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean))
      if (Buffer.from(prev, 'base64').length !== 32)
        ctx.addIssue({
          code: 'custom',
          path: ['TOKEN_CACHE_PREVIOUS_KEYS'],
          message: 'each entry must be a 32-byte key, base64 (comma-separated)',
        });
    if (env.TOKEN_CACHE_KEY && Buffer.from(env.TOKEN_CACHE_KEY, 'base64').length !== 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOKEN_CACHE_KEY'],
        message: 'TOKEN_CACHE_KEY must be 32 random bytes, base64 (openssl rand -base64 32)',
      });
    }
    // A malformed audit chain key is refused, never ignored: the portal would otherwise run unkeyed unnoticed.
    for (const { key, message } of chainKeyProblems(env))
      ctx.addIssue({ code: 'custom', path: [key], message });
    if (env.AUDIT_CHAIN_KEY && env.AUDIT_CHAIN_KEY === env.TOKEN_CACHE_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['AUDIT_CHAIN_KEY'],
        message: 'must be a key of its own, not the same as TOKEN_CACHE_KEY',
      });
    if (Boolean(env.AF_WRITE_CLIENT_ID) !== Boolean(env.AF_WRITE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['AF_WRITE_CLIENT_ID'],
        message: 'AF_WRITE_CLIENT_ID and AF_WRITE_CLIENT_SECRET must be set together',
      });
    }
    if (env.AF_AUTOMATION_CLIENT_ID && !env.AF_AUTOMATION_CLIENT_SECRET && !env.AF_AUTOMATION_CERT_PATH) {
      ctx.addIssue({
        code: 'custom',
        path: ['AF_AUTOMATION_CLIENT_ID'],
        message: 'AF_AUTOMATION_CLIENT_ID needs AF_AUTOMATION_CERT_PATH or AF_AUTOMATION_CLIENT_SECRET',
      });
    }
    if ((env.CONTENT_SOURCE ?? (env.NODE_ENV === 'production' ? 'db' : 'fs')) === 'db')
      need('DATABASE_PATH', 'when CONTENT_SOURCE=db');
    for (const host of (env.AF_CONNECTION_AUDIENCE_HOSTS ?? '').split(/[\s,]+/).filter(Boolean)) {
      if (!/^(?=.{1,253}\.?$)([A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}\.?$/.test(host))
        ctx.addIssue({
          code: 'custom',
          path: ['AF_CONNECTION_AUDIENCE_HOSTS'],
          message: 'must be host names only, comma-separated (for example api.contoso.com), without https://',
        });
    }
    // Mock sign-in hands every visitor every portal role without a password: only ever on this machine, on
    // synthetic data, with no credentials that could reach the tenant. "This machine" is the interface the API listens
    // on and the address the portal is configured to be reached at (PUBLIC_BASE_URL: a proxy or a tunnel set up for
    // it). Configuration only: a tunnel to the loopback port that leaves PUBLIC_BASE_URL alone still gets through, as
    // the API doesn't check the Host header (docs/backlog.md).
    if (env.AUTH_MODE === 'mock') {
      if (env.DATA_MODE !== 'fixtures')
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_MODE'],
          message: 'mock sign-in needs DATA_MODE=fixtures (it never runs against tenant data)',
        });
      if (env.API_HOST !== undefined && !isLoopbackHost(env.API_HOST))
        ctx.addIssue({
          code: 'custom',
          path: ['API_HOST'],
          message: 'mock sign-in only listens on loopback (127.0.0.1, ::1 or localhost)',
        });
      if (!isLoopbackHost(new URL(env.PUBLIC_BASE_URL).hostname))
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_BASE_URL'],
          message:
            'mock sign-in only serves this machine: use http://localhost:<port> (behind a proxy or tunnel every visitor would get every role)',
        });
      for (const key of MOCK_FORBIDDEN_KEYS)
        if (env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `must not be set with AUTH_MODE=mock (mock sign-in never holds tenant or runner credentials; use ADMINFORGE_ENV_FILE=/dev/null)`,
          });
    }
  })
  .transform((env) => {
    const root = workspaceRoot();
    return {
      ...env,
      // Loopback unless asked otherwise (a developer's machine); the container sets 0.0.0.0 (the pod's Service reaches it).
      API_HOST: env.API_HOST ?? '127.0.0.1',
      ADMINFORGE_FIXTURES_DIR: path.resolve(
        env.ADMINFORGE_FIXTURES_DIR ?? path.join(root, 'tests', 'fixtures'),
      ),
      WEB_DIST_DIR: path.resolve(env.WEB_DIST_DIR ?? path.join(root, 'portal', 'apps', 'web', 'dist')),
      MOCK_ROLES: env.MOCK_ROLES as PortalRole[],
      CONTENT_SOURCE:
        env.CONTENT_SOURCE ?? (env.NODE_ENV === 'production' ? ('db' as const) : ('fs' as const)),
      CONTENT_DIR: path.resolve(env.CONTENT_DIR ?? path.join(root, 'portal', 'content')),
      CONTENT_WATCH: env.CONTENT_WATCH ?? env.NODE_ENV === 'development',
      ADMINFORGE_ARTIFACTS_DIR: path.resolve(
        (env.ADMINFORGE_ARTIFACTS_DIR ?? '~/.local/share/adminforge/artifacts').replace(
          /^~(?=$|[\\/])/,
          homedir(),
        ),
      ),
      // `~/…` for a developer's own file (init:local writes one); production requires an absolute path (above).
      ...(env.DATABASE_PATH
        ? { DATABASE_PATH: path.resolve(env.DATABASE_PATH.replace(/^~(?=$|[\\/])/, homedir())) }
        : {}),
    };
  });

/** One named app identity (AF_SCHEDULE_IDENTITIES): its app registration and credential (never logged). */
export interface AppIdentityConfig {
  name: string;
  clientId: string;
  certPath?: string;
  clientSecret?: string;
}

export type Config = z.infer<typeof Schema> & {
  /** The named app identities, read from AF_IDENTITY_<NAME>_* (loadConfig; absent in hand-built test configs). */
  SCHEDULE_IDENTITIES?: readonly AppIdentityConfig[];
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The named app identities from AF_SCHEDULE_IDENTITIES and their AF_IDENTITY_<NAME>_* keys. Problems name keys only,
 * never values. Mock sign-in may name identities but never hold their credentials.
 */
export function scheduleIdentities(
  env: Record<string, string>,
  parsed: Pick<
    z.infer<typeof Schema>,
    | 'AF_SCHEDULE_IDENTITIES'
    | 'AUTH_MODE'
    | 'AF_AUTOMATION_CLIENT_ID'
    | 'AF_READ_CLIENT_ID'
    | 'AF_WRITE_CLIENT_ID'
    | 'AF_PROTECTED_APP_IDS'
  >,
): { identities: AppIdentityConfig[]; problems: string[] } {
  const problems: string[] = [];
  const identities: AppIdentityConfig[] = [];
  const names = (parsed.AF_SCHEDULE_IDENTITIES ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const taken = new Set(
    [parsed.AF_AUTOMATION_CLIENT_ID, parsed.AF_READ_CLIENT_ID, parsed.AF_WRITE_CLIENT_ID]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase()),
  );
  // Apps AdminForge must never change are never something it signs in as either.
  const protectedIds = new Set(
    (parsed.AF_PROTECTED_APP_IDS ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((v) => v.toLowerCase()),
  );
  for (const name of new Set(names)) {
    if (!IDENTITY_NAME.test(name) || name === 'automation') {
      problems.push(
        'AF_SCHEDULE_IDENTITIES: names are lower-case letters and digits with single dashes between (2–31 characters), and not "automation"',
      );
      continue;
    }
    const prefix = identityEnvPrefix(name);
    const clientId = env[`${prefix}CLIENT_ID`];
    const certPath = env[`${prefix}CERT_PATH`];
    const clientSecret = env[`${prefix}CLIENT_SECRET`];
    if (!clientId || !GUID.test(clientId)) {
      problems.push(
        `${prefix}CLIENT_ID: must be the application (client) id of the ${name} app registration`,
      );
      continue;
    }
    if (taken.has(clientId.toLowerCase())) {
      problems.push(
        `${prefix}CLIENT_ID: must be an app registration of its own, not the Read, Write or automation app`,
      );
      continue;
    }
    if (protectedIds.has(clientId.toLowerCase())) {
      problems.push(
        `${prefix}CLIENT_ID: is listed in AF_PROTECTED_APP_IDS; a protected app can't be a schedule identity`,
      );
      continue;
    }
    taken.add(clientId.toLowerCase());
    if (parsed.AUTH_MODE === 'mock') {
      if (certPath || clientSecret)
        problems.push(
          `${prefix}${certPath ? 'CERT_PATH' : 'CLIENT_SECRET'}: must not be set with AUTH_MODE=mock (mock sign-in never holds tenant credentials)`,
        );
    } else if (!certPath && !clientSecret) {
      problems.push(`${prefix}CLIENT_ID: needs ${prefix}CERT_PATH or ${prefix}CLIENT_SECRET`);
      continue;
    }
    identities.push({
      name,
      clientId,
      ...(certPath ? { certPath } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    });
  }
  return { identities, problems };
}

/** Empty values in the env file mean "not set". */
function compact(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== '') out[k] = v.trim();
  return out;
}

/**
 * Validated configuration from `loadEnv()` (env file overlaid by process.env).
 * Errors name the offending keys only — values (which may be secrets) are never echoed.
 */
export function loadConfig(env: Record<string, string | undefined> = loadEnv()): Config {
  const values = compact(env);
  const parsed = Schema.safeParse(values);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new Error(`Invalid AdminForge configuration:\n${lines.join('\n')}`);
  }
  const { identities, problems } = scheduleIdentities(values, parsed.data);
  if (parsed.data.NODE_ENV === 'production') problems.push(...strayCredentials(values));
  if (problems.length)
    throw new Error(`Invalid AdminForge configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  return { ...parsed.data, SCHEDULE_IDENTITIES: identities };
}

/** Keys of the Postgres releases that carry a database password. */
const RETIRED_CREDENTIAL_KEYS = ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'POSTGRES_PASSWORD'] as const;

/**
 * Credentials the running portal must never hold: provisioner and test-account keys (they belong in <env>.admin.env on
 * an operator's machine), and the Postgres releases' database passwords — both arrive when a whole env file is turned
 * into the pod's Secret. Names only, never values.
 */
function strayCredentials(values: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of ADMIN_ENV_KEYS)
    if (values[key])
      out.push(`${key}: must not be set where the portal runs (admin-only: keep it in <env>.admin.env)`);
  for (const key of RETIRED_CREDENTIAL_KEYS)
    if (values[key])
      out.push(`${key}: no longer used (ADR-016) and holds a database password — remove it from the Secret`);
  return out;
}

/**
 * The token-cache keys (TOKEN_CACHE_KEY seals; it and TOKEN_CACHE_PREVIOUS_KEYS open), or undefined when not
 * configured. Rotation: docs/operations.md → Database.
 */
export function tokenCacheKey(config: Config): Keyring | undefined {
  if (!config.TOKEN_CACHE_KEY) return undefined;
  const previous = (config.TOKEN_CACHE_PREVIOUS_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, 'base64'));
  return { current: Buffer.from(config.TOKEN_CACHE_KEY, 'base64'), previous };
}

export const writeAppConfigured = (config: Config) =>
  Boolean(config.AF_WRITE_CLIENT_ID && config.AF_WRITE_CLIENT_SECRET);

export const webDistAvailable = (config: Config) => existsSync(path.join(config.WEB_DIST_DIR, 'index.html'));
