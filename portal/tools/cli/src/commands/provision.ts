import { randomBytes } from 'node:crypto';
import { RESOURCES, OPTIONAL_RESOURCES, RESOURCE_KEYS } from '../provision/catalog';
import { buildAuthorizeUrl, checkAuthorizeUrl, clientCredentialToken, pkceChallenge, tokenRoles, TokenError } from '../provision/auth';
import { buildDesiredEntra } from '../provision/entra-desired';
import { applyEntraOps, fetchEntraState, fetchResources } from '../provision/entra-io';
import { planEntra } from '../provision/entra-plan';
import { buildDesiredIdentities, planIdentities, type IdentityOp } from '../provision/identities-plan';
import { applyIdentityOps, fetchIdentityState, readSecurityDefaults } from '../provision/identities-io';
import type { DesiredEntra, EntraOp, EntraState, ProvisionSettings } from '../provision/model';
import { counts, renderPlan, renderStatus, summaryLine } from '../provision/render';
import { appClients, ConfigError, envSubset, GRAPH_SCOPE, provisionerClients, provisionSettings, type CliContext, type Clients } from './context';

export interface EntraRun {
  settings: ProvisionSettings;
  desired: DesiredEntra;
  state: EntraState;
  ops: EntraOp[];
}

/** Read-only: fetch → desired → plan. */
export async function planEntraRun(ctx: CliContext, clients: Clients, settings = provisionSettings(ctx.env)): Promise<EntraRun> {
  const resources = await fetchResources(clients.graph);
  const desired = buildDesiredEntra(settings, resources);
  const state = await fetchEntraState(clients.graph, clients.arm, desired, resources, envSubset(ctx.env));
  return { settings, desired, state, ops: planEntra(desired, state, ctx.now?.() ?? new Date()) };
}

function printBlocked(ctx: CliContext, ops: Array<{ action: string; title: string; changes?: string[] }>) {
  const skipped = ops.filter((o) => o.action === 'skip');
  if (!skipped.length) return;
  ctx.out('');
  ctx.out('Not provisioned here (record in docs/licensing-review.md):');
  for (const s of skipped) ctx.out(`  ⚠ ${s.title} — ${s.changes?.join(', ') ?? 'skipped'}`);
}

/** `adminforge provision entra [--dry-run]` */
export async function provisionEntra(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<EntraRun> {
  const settings = provisionSettings(ctx.env);
  const clients = provisionerClients(ctx, settings);
  ctx.out(`AdminForge provision entra — environment "${settings.label}", redirect base ${settings.baseUrl}${opts.dryRun ? ' (dry run)' : ''}`);
  const run = await planEntraRun(ctx, clients, settings);
  for (const key of RESOURCE_KEYS)
    if (!run.state.resources[key])
      ctx.out(`  ⚠ ${RESOURCES[key].name} service principal not found in the tenant${OPTIONAL_RESOURCES.has(key) ? ' (workload not licensed)' : ''}; its permissions are skipped.`);
  ctx.out('');
  ctx.out('Plan:');
  renderPlan(run.ops, ctx.out);
  const c = counts(run.ops);
  if (opts.dryRun) {
    ctx.out('');
    ctx.out('Dry run: nothing was changed.');
  } else if (c.create + c.update === 0) {
    ctx.out('');
    ctx.out('Nothing to do: everything is already in the desired state.');
  } else {
    ctx.out('');
    ctx.out('Applying:');
    await applyEntraOps(run.ops, run.state, { graph: clients.graph, arm: clients.arm, writeEnv: ctx.writeEnv, log: ctx.out, retry: { sleep: ctx.sleep, ...ctx.retry }, now: ctx.now });
    ctx.out('');
    ctx.out(`Done: ${c.create} created, ${c.update} updated, ${c.noop} unchanged, ${c.skip} skipped.`);
  }
  printBlocked(ctx, run.ops);
  return run;
}

export interface IdentitiesRun {
  ops: IdentityOp[];
  securityDefaults: boolean | 'unknown';
}

async function identityPlan(ctx: CliContext, clients: Clients, settings: ProvisionSettings) {
  if (!settings.primaryDomain) throw new ConfigError('AF_PRIMARY_DOMAIN must be set in the env file.');
  const desired = buildDesiredIdentities({ label: settings.label, domain: settings.primaryDomain, testerUpn: ctx.env.AF_TEST_USER_UPN });
  const env = { upn: ctx.env.AF_TEST_USER_UPN || undefined, password: ctx.env.AF_TEST_USER_PASSWORD || undefined };
  const state = await fetchIdentityState(clients.graph, desired, env);
  return { desired, state, ops: planIdentities(desired, state) };
}

/** Security Defaults via the provisioner, then the automation identity (which holds Policy.Read.All). */
async function securityDefaults(ctx: CliContext, clients: Clients, settings: ProvisionSettings) {
  const automation = appClients(ctx, settings, 'automation');
  try {
    return await readSecurityDefaults([clients.graph, ...(automation ? [automation.graph] : [])]);
  } catch {
    return 'unknown' as const;
  }
}

const securityDefaultsLine = (v: boolean | 'unknown') =>
  v === 'unknown'
    ? 'Security Defaults: unknown (no identity available here may read the policy)'
    : v
      ? 'Security Defaults: ENABLED — the test user will be prompted to register MFA, which blocks unattended Playwright sign-in'
      : 'Security Defaults: disabled';

/** `adminforge provision test-identities [--dry-run]` */
export async function provisionTestIdentities(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<IdentitiesRun> {
  const settings = provisionSettings(ctx.env);
  const clients = provisionerClients(ctx, settings);
  ctx.out(`AdminForge provision test-identities — environment "${settings.label}"${opts.dryRun ? ' (dry run)' : ''}`);
  const { state, ops } = await identityPlan(ctx, clients, settings);
  ctx.out('');
  ctx.out('Plan:');
  renderPlan(ops, ctx.out);
  const c = counts(ops);
  ctx.out('');
  if (opts.dryRun) ctx.out('Dry run: nothing was changed.');
  else if (c.create + c.update === 0) ctx.out('Nothing to do: everything is already in the desired state.');
  else {
    ctx.out('Applying:');
    await applyIdentityOps(ops, state, { graph: clients.graph, writeEnv: ctx.writeEnv, log: ctx.out, retry: { sleep: ctx.sleep, ...ctx.retry } });
    ctx.out('');
    ctx.out(`Done: ${c.create} created, ${c.update} updated, ${c.noop} unchanged, ${c.skip} skipped.`);
  }
  const sd = await securityDefaults(ctx, clients, settings);
  ctx.out(securityDefaultsLine(sd));
  printBlocked(ctx, ops);
  return { ops, securityDefaults: sd };
}

export interface StatusResult {
  ok: boolean;
  failures: string[];
}

/** `adminforge provision status` — the plan, shown as a checklist, plus live token checks. */
export async function provisionStatus(ctx: CliContext): Promise<StatusResult> {
  const settings = provisionSettings(ctx.env);
  const clients = provisionerClients(ctx, settings);
  const failures: string[] = [];
  ctx.out(`AdminForge provision status — environment "${settings.label}"`);
  ctx.out('');

  const run = await planEntraRun(ctx, clients, settings);
  renderStatus(run.ops, ctx.out);
  failures.push(...run.ops.filter((o) => o.action === 'create' || o.action === 'update').map((o) => o.title));

  let identityOps: IdentityOp[] = [];
  if (settings.primaryDomain) {
    identityOps = (await identityPlan(ctx, clients, settings)).ops;
    renderStatus(identityOps, ctx.out);
    failures.push(...identityOps.filter((o) => o.action === 'create' || o.action === 'update').map((o) => o.title));
  } else ctx.out('  ⚠ Test identities — AF_PRIMARY_DOMAIN is not set');

  ctx.out('  Token checks');
  const check = (ok: boolean, line: string, detail?: string) => {
    ctx.out(`    ${ok ? '✓' : '✗'} ${line}`);
    if (detail) ctx.out(`        ${detail}`);
    if (!ok) failures.push(line);
  };
  const doFetch = ctx.fetch ?? fetch;

  for (const app of ['read', 'write', 'automation'] as const) {
    const desiredApp = run.desired.apps.find((a) => a.key === app)!;
    const id = ctx.env[desiredApp.env.clientId];
    const secret = ctx.env[desiredApp.env.secret];
    const name = desiredApp.body.displayName;
    if (!id || !secret) {
      check(false, `${name}: client credentials in env file`, `${desiredApp.env.clientId} / ${desiredApp.env.secret} missing`);
      continue;
    }
    try {
      const token = await clientCredentialToken({ tenantId: settings.tenantId, clientId: id, clientSecret: secret, scope: GRAPH_SCOPE, fetch: ctx.fetch })();
      if (app !== 'automation') {
        check(true, `${name}: stored client secret is accepted by Entra`);
        continue;
      }
      const roles = tokenRoles(token);
      const expected = desiredApp.appPermissions.flatMap((p) => p.roles.map((r) => r.value));
      const missing = expected.filter((r) => !roles.includes(r));
      check(missing.length === 0, `${name}: app-only token carries ${roles.length}/${expected.length} expected roles`, missing.length ? `missing: ${missing.join(', ')}` : `roles: ${roles.join(', ')}`);
    } catch (err) {
      check(false, `${name}: client-credentials token`, err instanceof TokenError ? `${err.aadsts ?? err.error}` : String(err));
    }
  }

  const readId = ctx.env.AF_READ_CLIENT_ID;
  if (readId) {
    const redirectUri = `${settings.baseUrl}/auth/callback`;
    const url = buildAuthorizeUrl({
      tenantId: settings.tenantId,
      clientId: readId,
      redirectUri,
      scopes: ['openid', 'profile', 'offline_access', 'User.Read'],
      state: randomBytes(16).toString('base64url'),
      codeChallenge: pkceChallenge(randomBytes(32).toString('base64url')),
    });
    const problems = checkAuthorizeUrl(url, { tenantId: settings.tenantId, clientId: readId, redirectUri });
    const readApp = run.state.apps.read;
    if (readApp?.appId !== readId) problems.push('AF_READ_CLIENT_ID is not the Read app registration');
    if (!(readApp?.web?.redirectUris ?? []).includes(redirectUri)) problems.push('redirect_uri is not registered on the Read app');
    check(problems.length === 0, 'Read app authorize URL is well-formed (auth code + PKCE S256; client_id and redirect_uri match the registration)', problems.join('; ') || undefined);
    try {
      // Entra only validates client_id/redirect_uri after a user identifies, so check the endpoint against OIDC discovery.
      const res = await doFetch(`https://login.microsoftonline.com/${settings.tenantId}/v2.0/.well-known/openid-configuration`);
      const discovery = (await res.json()) as { authorization_endpoint?: string };
      const u = new URL(url);
      check(discovery.authorization_endpoint === `${u.origin}${u.pathname}`, 'Authorize endpoint matches the tenant OIDC discovery document');
    } catch (err) {
      check(false, 'Authorize endpoint matches the tenant OIDC discovery document', String(err));
    }
  }

  const sd = await securityDefaults(ctx, clients, settings);
  ctx.out(`  ${sd === true ? '⚠' : 'ℹ'} ${securityDefaultsLine(sd)}`);
  printBlocked(ctx, [...run.ops, ...identityOps]);
  ctx.out('');
  ctx.out(failures.length ? `${failures.length} item(s) not in the desired state. Run \`pnpm adminforge provision entra\` / \`provision test-identities\`.` : `All provisioned items are in the desired state (${summaryLine([...run.ops, ...identityOps])}).`);
  return { ok: failures.length === 0, failures };
}
