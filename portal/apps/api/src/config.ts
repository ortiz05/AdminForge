import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '@adminforge/config';
import { PORTAL_ROLES, type PortalRole } from '@adminforge/schemas';
import { z } from 'zod';
import { workspaceRoot } from './paths';

const ALL_ROLES = PORTAL_ROLES.join(',');

/** Comma-separated portal roles (MOCK_ROLES). */
const RoleList = z
  .string()
  .transform((s) => s.split(',').map((r) => r.trim()).filter(Boolean))
  .pipe(z.array(z.enum(PORTAL_ROLES)).min(1, 'at least one portal role is required'));

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    /** Interface to bind; defaults to loopback except in production containers. */
    API_HOST: z.string().optional(),
    PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    /** Fastify trustProxy: IPs/CIDRs or proxy-addr presets (loopback, linklocal, uniquelocal). */
    TRUST_PROXY: z.string().default('loopback'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),

    AUTH_MODE: z.enum(['entra', 'mock']).default('entra'),
    DATA_MODE: z.enum(['live', 'fixtures']).default('live'),
    ADMINFORGE_FIXTURES_DIR: z.string().optional(),
    WEB_DIST_DIR: z.string().optional(),
    MOCK_ROLES: RoleList.prefault(ALL_ROLES),

    DATABASE_URL: z.string().optional(),
    TOKEN_CACHE_KEY: z.string().optional(),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(7 * 24).default(12),
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

    // ── Automation identity, content registry, outbound calls (definitions/datasources) ──
    AF_AUTOMATION_CLIENT_ID: z.guid().optional(),
    AF_AUTOMATION_CLIENT_SECRET: z.string().optional(),
    /** PEM with certificate + private key; preferred over the secret. */
    AF_AUTOMATION_CERT_PATH: z.string().optional(),
    /** fs = portal/content from disk (hot reload); db = published versions in Postgres. Default: db in production, else fs. */
    CONTENT_SOURCE: z.enum(['fs', 'db']).optional(),
    CONTENT_DIR: z.string().optional(),
    /** Watch CONTENT_DIR and reload on change (default: on in development). */
    CONTENT_WATCH: z.stringbool().optional(),
    OUTBOUND_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(16),
    OUTBOUND_USER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(6),
    OUTBOUND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
    SEARCH_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(2500),
    EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
    // PowerShell runner on this host (apps/runner); both unset = PowerShell steps/datasources disabled.
    RUNNER_URL: z.url().optional(),
    RUNNER_SHARED_KEY: z.string().min(40).optional(),
    // Consume run jobs inside the API process (single-process installs); otherwise run `ROLE=worker`.
    RUN_WORKER_IN_PROCESS: z.stringbool().default(false),
    RUN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  })
  .superRefine((env, ctx) => {
    const need = (key: keyof typeof env, why: string) => {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required ${why}` });
    };
    if (env.AUTH_MODE === 'entra') {
      for (const key of ['AF_TENANT_ID', 'AF_READ_CLIENT_ID', 'AF_READ_CLIENT_SECRET', 'TOKEN_CACHE_KEY', 'DATABASE_URL'] as const) {
        need(key, 'when AUTH_MODE=entra');
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_MODE === 'mock') {
        ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'mock auth is not allowed in production' });
      }
      need('DATABASE_URL', 'in production');
      const url = new URL(env.PUBLIC_BASE_URL);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'must be https in production (the session cookie is Secure)' });
      }
    }
    if (env.TOKEN_CACHE_KEY && Buffer.from(env.TOKEN_CACHE_KEY, 'base64').length !== 32) {
      ctx.addIssue({ code: 'custom', path: ['TOKEN_CACHE_KEY'], message: 'TOKEN_CACHE_KEY must be 32 random bytes, base64 (openssl rand -base64 32)' });
    }
    if (Boolean(env.AF_WRITE_CLIENT_ID) !== Boolean(env.AF_WRITE_CLIENT_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['AF_WRITE_CLIENT_ID'], message: 'AF_WRITE_CLIENT_ID and AF_WRITE_CLIENT_SECRET must be set together' });
    }
    if (env.AF_AUTOMATION_CLIENT_ID && !env.AF_AUTOMATION_CLIENT_SECRET && !env.AF_AUTOMATION_CERT_PATH) {
      ctx.addIssue({ code: 'custom', path: ['AF_AUTOMATION_CLIENT_ID'], message: 'AF_AUTOMATION_CLIENT_ID needs AF_AUTOMATION_CERT_PATH or AF_AUTOMATION_CLIENT_SECRET' });
    }
    if ((env.CONTENT_SOURCE ?? (env.NODE_ENV === 'production' ? 'db' : 'fs')) === 'db') need('DATABASE_URL', 'when CONTENT_SOURCE=db');
  })
  .transform((env) => {
    const root = workspaceRoot();
    return {
      ...env,
      API_HOST: env.API_HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
      ADMINFORGE_FIXTURES_DIR: path.resolve(env.ADMINFORGE_FIXTURES_DIR ?? path.join(root, 'tests', 'fixtures')),
      WEB_DIST_DIR: path.resolve(env.WEB_DIST_DIR ?? path.join(root, 'portal', 'apps', 'web', 'dist')),
      MOCK_ROLES: env.MOCK_ROLES as PortalRole[],
      CONTENT_SOURCE: env.CONTENT_SOURCE ?? (env.NODE_ENV === 'production' ? ('db' as const) : ('fs' as const)),
      CONTENT_DIR: path.resolve(env.CONTENT_DIR ?? path.join(root, 'portal', 'content')),
      CONTENT_WATCH: env.CONTENT_WATCH ?? env.NODE_ENV === 'development',
    };
  });

export type Config = z.infer<typeof Schema>;

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
  const parsed = Schema.safeParse(compact(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new Error(`Invalid AdminForge configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** The token-cache key as bytes, or undefined when not configured. */
export function tokenCacheKey(config: Config): Buffer | undefined {
  return config.TOKEN_CACHE_KEY ? Buffer.from(config.TOKEN_CACHE_KEY, 'base64') : undefined;
}

export const writeAppConfigured = (config: Config) => Boolean(config.AF_WRITE_CLIENT_ID && config.AF_WRITE_CLIENT_SECRET);

export const webDistAvailable = (config: Config) => existsSync(path.join(config.WEB_DIST_DIR, 'index.html'));
