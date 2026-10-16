/**
 * `adminforge fixtures record <page> [--datasource <name>] [--param k=v]… [--env <name>] [--force] [--dry-run]` —
 * turns a live read of one page into synthetic fixtures that DATA_MODE=fixtures serves.
 *
 * 1. Runs the page's datasources through the API's own DatasourceRunner and outbound executor (content/api-bridge.ts)
 *    as the **automation identity, read mode** — the same requests the portal would make; a recording fetch keeps
 *    every response. Graph `$batch` responses are split into one fixture per sub-request.
 * 2. Sanitizes everything in two passes (content/sanitize.ts): GUIDs, UPNs, e-mail addresses, tenant domains, names,
 *    IP addresses and paging tokens get consistent synthetic stand-ins. Microsoft's tenant-independent GUIDs
 *    (provision/catalog.ts) stay as they are.
 * 3. Refuses any file that would still contain a value from the local env file — the same tenant-data rule as the
 *    no-tenant-data guard (@adminforge/config `tenantValues`) — and writes the rest under tests/fixtures. Existing
 *    files are kept unless --force; the generic `<METHOD>.json` fallback is only ever created.
 *
 * Reads AF_TENANT_ID, AF_AUTOMATION_CLIENT_ID, AF_AUTOMATION_CERT_PATH or _SECRET, AF_SPO_TENANT_NAME,
 * AF_PRIMARY_DOMAIN and the non-secret AF_* keys content may use. Reads the tenant only (GET and read-only POST
 * queries); changes nothing there. Writes local fixture files. Exit code 1 when a datasource failed or a file was
 * refused.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tenantValues } from '@adminforge/config';
import { fixtureKey } from '@adminforge/connectors';
import { ConfigError } from '../shared/errors';
import {
  createAutomationTokenProvider,
  createOutboundExecutor,
  DatasourceRunner,
  FsDefinitionSource,
  registryFrom,
} from '../content/api-bridge';
import { relPath, type ContentCliContext } from '../content/context';
import { kindFromPath, Sanitizer } from '../content/sanitize';
import { AZURE_READER_ROLE_ID, DIRECTORY_ROLES, RESOURCES } from '../provision/catalog';

/** One recorded HTTP exchange. */
interface Recorded {
  method: string;
  url: string;
  status: number;
  body: unknown;
}

/** Env keys content must never see while recording (secrets, credentials, test and provisioner identities). */
const EXCLUDED_ENV = /SECRET|PASSWORD|TOKEN|WEBHOOK|_KEY$|CERT|TOTP|PRIVATE|^AF_TEST_|^AF_PROVISIONER_/i;

function decodeBody(text: string, contentType: string): unknown {
  if (!text) return undefined;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON after all: keep the text as recorded.
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

/** Tenant-independent Microsoft GUIDs the sanitizer keeps (resource app ids, role template ids). */
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
    // The no-tenant-data guard's rule, applied to the loaded env (which also carries the process environment).
    forbidden: tenantValues(ctx.env, { configKeysOnly: true }),
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
    for (const [i, relFile] of targets.entries()) {
      const file = path.join(ctx.fixturesDir, relFile);
      const exists = existsSync(file);
      // The generic fallback (<METHOD>.json) is only created, never overwritten.
      if (exists && (i > 0 || !opts.force)) {
        if (i === 0)
          ctx.out(
            `· kept ${relPath(ctx, file)} (exists; --force overwrites${relFile.endsWith('/POST.json') ? '; POST fixtures are shared — add a variant by hand' : ''})`,
          );
        continue;
      }
      if (opts.dryRun) ctx.out(`· would write ${relPath(ctx, file)}`);
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
        ctx.out(`✓ wrote ${relPath(ctx, file)}`);
        written++;
      }
    }
  }
  ctx.out(
    `${ok ? '✓' : '⚠'} ${items.length} response(s) sanitized, ${written} file(s) ${opts.dryRun ? 'not written (dry run)' : 'written'}.`,
  );
  return ok;
}
