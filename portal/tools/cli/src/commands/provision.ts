/**
 * `adminforge provision entra [--dry-run]`, `provision test-identities [--dry-run | --enable | --disable |
 * --remove-fixtures]` and `provision status`.
 *
 * Each command follows the provisioning pattern (README.md → Provisioning): validated settings
 * (provision/settings.ts) → desired state (provision/entra-desired.ts, identities-plan.ts) → fetched state as the
 * provisioner identity (provision/entra-io.ts, identities-io.ts) → plan (entra-plan.ts, identities-plan.ts) →
 * apply, unless --dry-run. `provision status` prints the same plan as a checklist, adds checks for privilege nobody
 * provisioned (provision/unexpected.ts), live token checks for the three apps, the Read app's authorize URL, the Azure
 * test environment (commands/azure-test.ts) and Security Defaults. The opt-in licensed test fixtures (licences, PIM,
 * named location, Intune, the approver) are planned, applied and shown next to the test identities through
 * commands/test-fixtures.ts. Changes only through the provisioner identity;
 * writes client ids and secrets to the env file (`ctx.writeEnv`), never prints them.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { repoRoot } from '@adminforge/config';
import { ApiError, type GraphClient } from '@adminforge/connectors';
import { loadContentDir } from '@adminforge/schemas';
import { declaredScopes, serviceForResource, type Declared } from '../content/scopes';
import { ConfigError } from '../shared/errors';
import { counts, isChange, renderPlan, renderStatus, summaryLine } from '../shared/output';
import { RESOURCES, OPTIONAL_RESOURCES, RESOURCE_KEYS } from '../provision/catalog';
import {
  buildAuthorizeUrl,
  checkAuthorizeUrl,
  clientCredentialToken,
  pkceChallenge,
  tokenRoles,
  TokenError,
} from '../provision/auth';
import {
  appClients,
  appCredential,
  GRAPH_SCOPE,
  provisionerClients,
  type CliContext,
  type Clients,
} from '../provision/clients';
import { buildDesiredEntra, type ContentScopes } from '../provision/entra-desired';
import { applyEntraOps, fetchEntraState, fetchResources } from '../provision/entra-io';
import { planEntra } from '../provision/entra-plan';
import {
  buildDesiredIdentities,
  isProvisionedApprover,
  licensedServices,
  planIdentities,
  testIdentitiesExist,
  unexpectedTesterRoles,
  type IdentityOp,
} from '../provision/identities-plan';
import {
  applyIdentityOps,
  fetchIdentityState,
  findUser,
  readSecurityDefaults,
  setUserEnabled,
} from '../provision/identities-io';
import type { DesiredEntra, EntraOp, EntraState, ProvisionSettings } from '../provision/model';
import { envSubset, provisionSettings, testIdentityLabels } from '../provision/settings';
import { findUnexpected, unexpectedFailures } from '../provision/unexpected';
import { azureTestStatus } from './azure-test';
import {
  applyFixtures,
  approverUpnOf,
  fixturesFailed,
  fixtureStatusWarnings,
  permissionHints,
  planFixturesRun,
  printFixturesPlan,
  provisionerStandingLines,
  setApproverEnabled,
} from './test-fixtures';
import { readEligibleRoles, unexpectedEligibleRoles } from '../provision/eligibility';
import { fixtureSettings } from '../provision/fixtures-plan';
import { FIXTURE_ROLES, type FixtureOp } from '../provision/fixtures-model';

export interface EntraRun {
  settings: ProvisionSettings;
  desired: DesiredEntra;
  state: EntraState;
  ops: EntraOp[];
  /** Which content files declare each permission (`app:service:scope`), for warnings. */
  files: Declared['files'];
}

/** Everything portal/content declares (requires.scopes), with the files that declare it. */
export async function contentDeclarations(
  contentDir = path.join(repoRoot, 'portal', 'content'),
): Promise<Declared> {
  const { definitions } = await loadContentDir(contentDir);
  return declaredScopes(definitions);
}

/** Permissions declared by portal/content (requires.scopes) — provisioning grants exactly these on top of the baseline. */
export async function contentScopes(
  contentDir = path.join(repoRoot, 'portal', 'content'),
): Promise<ContentScopes> {
  return (await contentDeclarations(contentDir)).scopes;
}

/** Read-only: fetch → desired → plan. */
export async function planEntraRun(
  ctx: CliContext,
  clients: Clients,
  settings = provisionSettings(ctx.env),
): Promise<EntraRun> {
  const declared = ctx.contentScopes
    ? { scopes: ctx.contentScopes, files: ctx.contentFiles ?? new Map<string, string[]>() }
    : await contentDeclarations();
  const resources = await fetchResources(clients.graph);
  const desired = buildDesiredEntra(settings, resources, declared.scopes as ContentScopes);
  const state = await fetchEntraState(clients.graph, clients.arm, desired, resources, envSubset(ctx.env));
  return {
    settings,
    desired,
    state,
    ops: planEntra(desired, state, ctx.now?.() ?? new Date()),
    files: declared.files,
  };
}

/** A ceiling skip names the env key that lifts it ("set AF_…=true"); everything else is licensing or tenant shape. */
const isCeiling = (o: { changes?: string[] }) =>
  (o.changes ?? []).some((c) => /\bset AF_[A-Z_]+=true\b/.test(c));

function printBlocked(ctx: CliContext, ops: Array<{ action: string; title: string; changes?: string[] }>) {
  const skipped = ops.filter((o) => o.action === 'skip');
  const ceiling = skipped.filter(isCeiling);
  const other = skipped.filter((o) => !isCeiling(o));
  if (ceiling.length) {
    ctx.out('');
    ctx.out('Withheld by a permission ceiling (an explicit opt-in in the env file grants them):');
    for (const s of ceiling) ctx.out(`  ⚠ ${s.title} — ${s.changes?.join(', ') ?? 'skipped'}`);
  }
  if (!other.length) return;
  ctx.out('');
  ctx.out('Not provisioned here (record in docs/licensing-review.md):');
  for (const s of other) ctx.out(`  ⚠ ${s.title} — ${s.changes?.join(', ') ?? 'skipped'}`);
}

const listFiles = (files: string[] | undefined) =>
  files?.length
    ? `${files.slice(0, 4).join(', ')}${files.length > 4 ? `, … (${files.length} files)` : ''}`
    : '';

/**
 * Loud warning: write-capable delegated permissions requested for the READ app. The Read app is used in read mode by
 * everyone with a portal role; with these scopes only the API's read policy stands between a read session and a write.
 */
export function readAppWriteWarnings(run: Pick<EntraRun, 'desired' | 'files'>): string[] {
  const lines: string[] = [];
  const { readWriteCapable, readArmInherent } = run.desired;
  if (readWriteCapable.length) {
    lines.push(
      `⚠ WRITE-CAPABLE delegated permissions on the READ app ${run.desired.apps.find((a) => a.key === 'read')!.body.displayName} — anyone with a portal role holds them in read mode, so only the API's read-only request policy keeps them from writing. Move the content that needs them to write playbooks, or accept them in docs/access.md:`,
    );
    for (const w of readWriteCapable) {
      const files = run.files.get(`read:${serviceForResource(w.resource)}:${w.scope}`);
      lines.push(
        `    ${RESOURCES[w.resource].name}: ${w.scope}${w.granted ? '' : ' (not granted here: workload not licensed)'} — ${listFiles(files) || 'AdminForge baseline (portal/tools/cli/src/provision/catalog.ts)'}`,
      );
    }
  }
  if (readArmInherent)
    lines.push(
      'ℹ Azure Service Management user_impersonation on the Read app is inherent: Azure Resource Manager has no read-only delegated scope, so the user’s Azure RBAC roles bound what it can do.',
    );
  return lines;
}

/** `adminforge provision entra [--dry-run]` */
export async function provisionEntra(ctx: CliContext, opts: { dryRun?: boolean } = {}): Promise<EntraRun> {
  const settings = provisionSettings(ctx.env);
  const clients = provisionerClients(ctx, settings);
  ctx.out(
    `AdminForge provision entra — environment "${settings.label}", redirect base ${settings.baseUrl}${opts.dryRun ? ' (dry run)' : ''}`,
  );
  const run = await planEntraRun(ctx, clients, settings);
  for (const key of RESOURCE_KEYS)
    if (!run.state.resources[key])
      ctx.out(
        `  ⚠ ${RESOURCES[key].name} service principal not found in the tenant${OPTIONAL_RESOURCES.has(key) ? ' (workload not licensed)' : ''}; its permissions are skipped.`,
      );
  ctx.out('');
  ctx.out('Plan:');
  renderPlan(run.ops, ctx.out);
  const warnings = readAppWriteWarnings(run);
  if (warnings.length) ctx.out('');
  for (const w of warnings) ctx.out(w);
  const c = counts(run.ops);
  if (opts.dryRun) {
    ctx.out('');
    ctx.out('Dry run: nothing was changed.');
  } else if (c.changes === 0) {
    ctx.out('');
    ctx.out('Nothing to do: everything is already in the desired state.');
  } else {
    ctx.out('');
    ctx.out('Applying:');
    await applyEntraOps(run.ops, run.state, {
      graph: clients.graph,
      arm: clients.arm,
      writeEnv: ctx.writeEnv,
      log: ctx.out,
      retry: { sleep: ctx.sleep, ...ctx.retry },
      now: ctx.now,
    });
    ctx.out('');
    ctx.out(
      `Done: ${c.create} created, ${c.update} updated, ${c.delete ? `${c.delete} removed, ` : ''}${c.noop} unchanged, ${c.skip} skipped.`,
    );
  }
  printBlocked(ctx, run.ops);
  return run;
}

export interface IdentitiesRun {
  ops: IdentityOp[];
  /** The opted-in test fixtures' operations (empty when none is opted in). */
  fixtureOps: FixtureOp[];
  securityDefaults: boolean | 'unknown';
}

const notTestLabel = (ctx: CliContext, settings: ProvisionSettings) =>
  `Environment "${settings.label}" is not a test environment: test identities are only provisioned for labels in AF_TEST_IDENTITY_LABELS (now: ${testIdentityLabels(ctx.env).join(', ')}).`;

/** Service plans of the tenant's active subscriptions; [] when they can't be read (no extra tester roles then). */
async function tenantServicePlans(clients: Clients): Promise<string[]> {
  try {
    const { data } = await clients.graph.request<{
      value?: Array<{ capabilityStatus?: string; servicePlans?: Array<{ servicePlanName?: string }> }>;
    }>({ path: '/subscribedSkus', query: { $select: 'capabilityStatus,servicePlans' } });
    return (data.value ?? [])
      .filter((s) => ['enabled', 'warning'].includes((s.capabilityStatus ?? '').toLowerCase()))
      .flatMap((s) => (s.servicePlans ?? []).map((p) => p.servicePlanName ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function identityPlan(ctx: CliContext, clients: Clients, settings: ProvisionSettings) {
  if (!settings.primaryDomain) throw new ConfigError('AF_PRIMARY_DOMAIN must be set in the env file.');
  const desired = buildDesiredIdentities({
    label: settings.label,
    domain: settings.primaryDomain,
    testerUpn: ctx.env.AF_TEST_USER_UPN,
    approverUpn: approverUpnOf(ctx, settings),
    services: licensedServices(await tenantServicePlans(clients)),
    // Tenant-wide Exchange / SharePoint admin roles for the validation user: opt-in (admin file), default off.
    serviceAdminRoles: ctx.env.AF_TEST_SERVICE_ADMIN_ROLES === 'true',
  });
  const env = {
    upn: ctx.env.AF_TEST_USER_UPN || undefined,
    password: ctx.env.AF_TEST_USER_PASSWORD || undefined,
  };
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

/** Turns the validation user's sign-in on or off; prints one line. Throws ConfigError when it can't. */
async function setValidationUser(ctx: CliContext, graph: GraphClient, upn: string, enabled: boolean) {
  const result = await setUserEnabled(graph, upn, enabled);
  const state = enabled ? 'enabled' : 'disabled';
  if (result === 'refused')
    throw new ConfigError(
      'The account at AF_TEST_USER_UPN was not created by AdminForge provisioning (UPN af-…, display name "AF Tester" or the "AdminForge validation" marker), so it is neither enabled nor disabled here. Fix AF_TEST_USER_UPN.',
    );
  if (result === 'missing') {
    if (enabled)
      throw new ConfigError(
        'The validation user (AF_TEST_USER_UPN) does not exist. Run `pnpm adminforge provision test-identities` first.',
      );
    ctx.out('Validation user (AF_TEST_USER_UPN): does not exist — nothing to disable.');
    return false;
  }
  ctx.out(
    result === 'changed'
      ? `✓ Validation user (AF_TEST_USER_UPN): ${state}${enabled ? ' — Entra can take up to a minute to accept its sign-ins' : ', sign-in sessions revoked'}.`
      : `Validation user (AF_TEST_USER_UPN): already ${state}.`,
  );
  return result === 'changed';
}

/** A failure of one account's step in `--disable`, for the terminal: never a Graph message (it can carry ids). */
const disableFailure = (err: unknown) =>
  err instanceof ConfigError
    ? err.message
    : err instanceof ApiError
      ? `Graph answered ${err.status} ${err.code}`
      : 'failed (run with ADMINFORGE_DEBUG=1 for details)';

/**
 * `adminforge provision test-identities --enable [--approver] | --disable`: turns the validation user's sign-in on
 * for a live run and off again (it holds standing directory roles). The approver fixture (AF Tester 2) is enabled only
 * with an explicit `--approver` (and never where AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true); `--disable` always
 * disables both, trying each even when the other fails, and reports each. Idempotent; prints no identifiers.
 */
export async function setTesterEnabled(
  ctx: CliContext,
  enabled: boolean,
  opts: { approver?: boolean } = {},
): Promise<{ changed: boolean }> {
  const settings = provisionSettings(ctx.env);
  // Disabling is always allowed (it only removes access); enabling only in a test environment.
  if (enabled && !settings.testIdentitiesAllowed) throw new ConfigError(notTestLabel(ctx, settings));
  if (!enabled && opts.approver)
    throw new ConfigError('--approver goes with --enable only: --disable always disables both accounts.');
  const upn = ctx.env.AF_TEST_USER_UPN || (settings.primaryDomain && `af-tester@${settings.primaryDomain}`);
  if (!upn) throw new ConfigError('AF_TEST_USER_UPN (or AF_PRIMARY_DOMAIN) must be set in the env file.');
  const clients = provisionerClients(ctx, settings);
  if (enabled) {
    const changed = await setValidationUser(ctx, clients.graph, upn, true);
    const approverChanged = opts.approver
      ? await setApproverEnabled(ctx, clients.graph, settings, true)
      : false;
    return { changed: changed || approverChanged };
  }
  const failed: string[] = [];
  let changed = false;
  const steps: Array<[string, () => Promise<boolean>]> = [
    ['Validation user (AF_TEST_USER_UPN)', () => setValidationUser(ctx, clients.graph, upn, false)],
    ['Approver (AF_TEST_APPROVER_UPN)', () => setApproverEnabled(ctx, clients.graph, settings, false)],
  ];
  for (const [who, step] of steps)
    try {
      changed = (await step()) || changed;
    } catch (err) {
      ctx.out(`✗ ${who}: ${disableFailure(err)}`);
      failed.push(who);
    }
  if (failed.length) throw new ConfigError(`Not disabled: ${failed.join(', ')} — see ✗ above.`);
  return { changed };
}

/** `adminforge provision test-identities [--dry-run]` */
export async function provisionTestIdentities(
  ctx: CliContext,
  opts: { dryRun?: boolean } = {},
): Promise<IdentitiesRun> {
  const settings = provisionSettings(ctx.env);
  if (!settings.testIdentitiesAllowed) throw new ConfigError(notTestLabel(ctx, settings));
  const clients = provisionerClients(ctx, settings);
  ctx.out(
    `AdminForge provision test-identities — environment "${settings.label}"${opts.dryRun ? ' (dry run)' : ''}`,
  );
  // Opt-ins are checked before anything is read: a malformed AF_TEST_FIXTURES changes nothing.
  const fixtureOptIns = fixtureSettings(ctx.env);
  const { desired, state, ops } = await identityPlan(ctx, clients, settings);
  ctx.out('');
  ctx.out('Plan:');
  renderPlan(ops, ctx.out);
  const refused = ops.find((o) => o.kind === 'tester' && o.refused);
  if (refused?.kind === 'tester')
    throw new ConfigError(
      `Nothing was changed. Refusing to provision the validation user: ${refused.refused}.`,
    );
  for (const line of unexpectedTesterRoles(state).lines) ctx.out(`  ⚠ ${line}`);
  const fixtures = await planFixturesRun(ctx, clients, settings, desired);
  if (fixtures) {
    printFixturesPlan(fixtures, ctx.out);
    for (const line of await permissionHints(ctx, settings, fixtureOptIns)) ctx.out(`  ${line}`);
  }
  const fixtureOps = fixtures?.ops ?? [];
  const c = counts([...ops, ...fixtureOps]);
  let failed: Awaited<ReturnType<typeof applyFixtures>> = [];
  ctx.out('');
  if (opts.dryRun) ctx.out('Dry run: nothing was changed.');
  else if (c.changes === 0) ctx.out('Nothing to do: everything is already in the desired state.');
  else {
    ctx.out('Applying:');
    await applyIdentityOps(ops, state, {
      graph: clients.graph,
      writeEnv: ctx.writeEnv,
      log: ctx.out,
      retry: { sleep: ctx.sleep, ...ctx.retry },
    });
    // After the identities: the fixtures need the test users and AF-Test-Group-01.
    if (fixtures) failed = await applyFixtures(ctx, clients, fixtures);
    ctx.out('');
    ctx.out(
      `Done: ${c.create} created, ${c.update} updated, ${c.delete ? `${c.delete} removed, ` : ''}${c.noop} unchanged, ${c.skip} skipped.`,
    );
  }
  const sd = await securityDefaults(ctx, clients, settings);
  ctx.out(securityDefaultsLine(sd));
  printBlocked(ctx, ops);
  // Opted-in fixtures that failed, or can't be done here (✗ cannot): exit code 1 — except for a dry run.
  const notDone = [...new Set([...failed, ...fixtureOps.filter((o) => o.blocked).map((o) => o.fixture)])];
  if (notDone.length && !opts.dryRun) throw fixturesFailed(notDone);
  if (notDone.length)
    ctx.out(
      `${notDone.length} fixture(s) can't be provisioned as things stand (${notDone.join(', ')}) — see ✗ above.`,
    );
  return { ops, fixtureOps, securityDefaults: sd };
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
  failures.push(...run.ops.filter(isChange).map((o) => o.title));

  // Privilege nobody provisioned: extra assignments, permissions, grants, owners, credentials, sign-in surface, RBAC.
  ctx.out('  Unexpected privilege');
  const unexpected = findUnexpected(run.desired, run.state, ctx.now?.() ?? new Date());
  for (const u of unexpected)
    ctx.out(
      u.unknown
        ? `    ⚠ ${u.title} — ${u.unknown}`
        : `    ${u.problems.length ? '✗' : '✓'} ${u.title}${u.problems.length ? ` — ${u.problems.join('; ')}` : ''}`,
    );
  failures.push(...unexpectedFailures(unexpected));
  // Test-fixture permissions on the provisioner outlive its directory role: ⚠ while they are held.
  for (const line of await provisionerStandingLines(ctx, settings)) ctx.out(`    ${line}`);
  for (const w of readAppWriteWarnings(run)) ctx.out(`  ${w}`);

  let identityOps: IdentityOp[] = [];
  let fixtureOps: FixtureOp[] = [];
  if (!settings.primaryDomain) ctx.out('  ⚠ Test identities — AF_PRIMARY_DOMAIN is not set');
  else if (!settings.testIdentitiesAllowed) {
    // Production-like environment: the validation user and AF-Test-* objects must not exist here.
    const desired = buildDesiredIdentities({
      label: settings.label,
      domain: settings.primaryDomain,
      testerUpn: ctx.env.AF_TEST_USER_UPN,
    });
    const state = await fetchIdentityState(clients.graph, desired, {});
    const exists = testIdentitiesExist(state);
    const approverUpn = approverUpnOf(ctx, settings);
    const approver = approverUpn ? await findUser(clients.graph, approverUpn) : undefined;
    const line = `Test identities in a non-test environment (AF_ENV_LABEL is not in AF_TEST_IDENTITY_LABELS)`;
    ctx.out('  Test identities');
    ctx.out(
      exists
        ? `    ✗ ${line} — the validation user or AF-Test-* objects exist; delete them, or add this label to AF_TEST_IDENTITY_LABELS if it is a test tenant`
        : `    ✓ No test identities (environment "${settings.label}" is not a test environment)`,
    );
    if (exists) failures.push(line);
    if (approver && isProvisionedApprover(approver)) {
      const left = 'The approver test account (AF Tester 2) is left over in a non-test environment';
      ctx.out(`    ✗ ${left} — run \`pnpm adminforge provision test-identities --remove-fixtures\``);
      failures.push(left);
    }
  } else {
    const plan = await identityPlan(ctx, clients, settings);
    identityOps = plan.ops;
    renderStatus(identityOps, ctx.out);
    failures.push(...identityOps.filter(isChange).map((o) => o.title));
    const refused = identityOps.find((o) => o.kind === 'tester' && o.refused);
    if (refused) failures.push(`${refused.title}: not an account provisioning created`);
    const tester = identityOps.find((o) => o.kind === 'tester');
    if (tester?.action === 'noop' && tester.detail === 'account enabled')
      ctx.out(
        '    ⚠ The validation user is enabled: it holds standing directory roles. Disable it between live runs: `pnpm adminforge provision test-identities --disable`.',
      );
    // The opted-in licensed test fixtures: ✗ when missing, drifted or blocked (no permission, refused object).
    const fixtures = refused ? undefined : await planFixturesRun(ctx, clients, settings, plan.desired);
    if (fixtures) {
      fixtureOps = fixtures.ops;
      renderStatus(fixtureOps, ctx.out);
      failures.push(...fixtureOps.filter((o) => isChange(o) || o.blocked).map((o) => o.title));
      for (const line of fixtureStatusWarnings(fixtures)) ctx.out(`    ${line}`);
    }
    // Directory roles beyond what provisioning grants or removes (other roles, narrower scopes, through groups).
    if (plan.state.tester && !refused) {
      const unexpectedRoles = unexpectedTesterRoles(plan.state);
      ctx.out('  Validation user: unexpected privilege');
      if (unexpectedRoles.unknown) ctx.out(`    ⚠ Directory roles — ${unexpectedRoles.unknown}`);
      else if (!unexpectedRoles.lines.length)
        ctx.out('    ✓ No directory roles beyond the ones provisioning manages');
      for (const line of unexpectedRoles.lines) {
        ctx.out(`    ✗ ${line}`);
        failures.push(line);
      }
      // PIM-eligible roles: activatable with the stored password, so the same rule as active ones.
      const pimFixture = fixtureSettings(ctx.env).fixtures.includes('pim');
      const eligibilityChecks: Array<{ who: string; id: string; allowed: string[] }> = [
        {
          who: plan.state.tester.displayName ?? 'The validation user',
          id: plan.state.tester.id,
          allowed: pimFixture ? [FIXTURE_ROLES['Message Center Reader']] : [],
        },
      ];
      const approver = fixtures?.state.approver;
      // Only an account with the approver marker (a leftover one too): never someone else's at that UPN.
      if (approver?.user && isProvisionedApprover(approver.user))
        eligibilityChecks.push({ who: 'AF Tester 2', id: approver.user.id, allowed: [] });
      for (const c of eligibilityChecks) {
        const eligible = await readEligibleRoles(clients.graph, c.id);
        if ('unreadable' in eligible) {
          ctx.out(`    ⚠ ${c.who}: PIM-eligible roles — ${eligible.unreadable}`);
          continue;
        }
        const lines = unexpectedEligibleRoles(c.who, eligible, c.allowed);
        if (!lines.length)
          ctx.out(`    ✓ ${c.who}: no PIM-eligible roles beyond the ones provisioning manages`);
        for (const line of lines) {
          ctx.out(`    ✗ ${line}`);
          failures.push(line);
        }
      }
    }
  }

  ctx.out('  Token checks');
  const check = (ok: boolean, line: string, detail?: string) => {
    ctx.out(`    ${ok ? '✓' : '✗'} ${line}`);
    if (detail) ctx.out(`        ${detail}`);
    if (!ok) failures.push(line);
  };
  const doFetch = ctx.fetch ?? fetch;

  for (const app of ['read', 'write', 'automation'] as const) {
    const desiredApp = run.desired.apps.find((a) => a.key === app)!;
    const name = desiredApp.body.displayName;
    let credential: ReturnType<typeof appCredential>;
    try {
      credential = appCredential(ctx, app);
    } catch (err) {
      check(false, `${name}: client credentials`, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!credential) {
      check(
        false,
        `${name}: client credentials in env file`,
        `${desiredApp.env.clientId} / ${desiredApp.env.secret}${app === 'automation' ? ' (or AF_AUTOMATION_CERT_PATH)' : ''} missing`,
      );
      continue;
    }
    try {
      const token = await clientCredentialToken({
        tenantId: settings.tenantId,
        clientId: credential.clientId,
        ...credential.credential,
        scope: GRAPH_SCOPE,
        fetch: ctx.fetch,
      })();
      if (app !== 'automation') {
        check(true, `${name}: stored client secret is accepted by Entra`);
        continue;
      }
      if (credential.kind === 'certificate')
        check(true, `${name}: certificate (AF_AUTOMATION_CERT_PATH) is accepted by Entra`);
      const roles = tokenRoles(token);
      const expected = desiredApp.appPermissions.flatMap((p) => p.roles.map((r) => r.value));
      const missing = expected.filter((r) => !roles.includes(r));
      check(
        missing.length === 0,
        `${name}: app-only token carries ${roles.length}/${expected.length} expected roles`,
        missing.length ? `missing: ${missing.join(', ')}` : `roles: ${roles.join(', ')}`,
      );
    } catch (err) {
      check(
        false,
        `${name}: client-credentials token`,
        err instanceof TokenError ? `${err.aadsts ?? err.error}` : String(err),
      );
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
    if (!(readApp?.web?.redirectUris ?? []).includes(redirectUri))
      problems.push('redirect_uri is not registered on the Read app');
    check(
      problems.length === 0,
      'Read app authorize URL is well-formed (auth code + PKCE S256; client_id and redirect_uri match the registration)',
      problems.join('; ') || undefined,
    );
    try {
      // Entra only validates client_id/redirect_uri after a user identifies, so check the endpoint against OIDC discovery.
      const res = await doFetch(
        `https://login.microsoftonline.com/${settings.tenantId}/v2.0/.well-known/openid-configuration`,
      );
      const discovery = (await res.json()) as { authorization_endpoint?: string };
      const u = new URL(url);
      check(
        discovery.authorization_endpoint === `${u.origin}${u.pathname}`,
        'Authorize endpoint matches the tenant OIDC discovery document',
      );
    } catch (err) {
      check(false, 'Authorize endpoint matches the tenant OIDC discovery document', String(err));
    }
  }

  // Azure test environment for live KQL validation (optional: shown, but only drift or a failed query counts).
  const azure = await azureTestStatus(ctx, clients);
  failures.push(...azure.failures);

  const sd = await securityDefaults(ctx, clients, settings);
  ctx.out(`  ${sd === true ? '⚠' : 'ℹ'} ${securityDefaultsLine(sd)}`);
  // A refused validation user is a failure above, not something licensing or a ceiling withholds.
  printBlocked(ctx, [...run.ops, ...identityOps.filter((o) => !(o.kind === 'tester' && o.refused))]);
  ctx.out('');
  ctx.out(
    failures.length
      ? `${failures.length} item(s) not in the desired state. Run \`pnpm adminforge provision entra\` / \`provision test-identities\` / \`provision azure-test\`; remove unexpected privilege in the Entra admin centre.`
      : `All provisioned items are in the desired state (${summaryLine([...run.ops, ...identityOps, ...fixtureOps, ...azure.ops])}).`,
  );
  return { ok: failures.length === 0, failures };
}
