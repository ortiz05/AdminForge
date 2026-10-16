/**
 * The licensed test fixtures part of `adminforge provision test-identities` (opt-in: AF_TEST_LICENCE_SKU,
 * AF_TEST_FIXTURES; see provision/fixtures-model.ts): planning them next to the test identities, applying them after
 * the identities, showing them in `provision status`, `--remove-fixtures` (any label: it only removes marked
 * objects), enabling the approver account (`--enable --approver`) and disabling it with the validation user, and the
 * status warning for fixture permissions the provisioner still holds. Thin: the plans are in
 * provision/fixtures-plan.ts and approver-plan.ts, the Graph I/O in provision/fixtures-io.ts and approver-io.ts.
 * Prints names, counts and statuses only — never ids or secrets.
 */
import type { GraphClient } from '@adminforge/connectors';
import { ConfigError } from '../shared/errors';
import { counts, renderPlan } from '../shared/output';
import { clientCredentialToken, tokenRoles } from '../provision/auth';
import { GRAPH_SCOPE, provisionerClients, type CliContext, type Clients } from '../provision/clients';
import { applyFixtureOps, fetchFixtureState } from '../provision/fixtures-io';
import {
  FIXTURE_NAMES,
  FIXTURE_PERMISSIONS,
  fixturesEnabled,
  heldPermission,
  isUnreadable,
  standingFixturePermissions,
  wants,
  type DesiredFixtures,
  type FixtureKey,
  type FixtureOp,
  type FixtureSettings,
  type FixtureState,
} from '../provision/fixtures-model';
import {
  buildDesiredFixtures,
  fixtureSettings,
  planFixtureRemoval,
  planFixtures,
  unexpectedGroupMembers,
} from '../provision/fixtures-plan';
import { setUserEnabled } from '../provision/identities-io';
import {
  buildDesiredIdentities,
  isProvisionedApprover,
  type DesiredIdentities,
} from '../provision/identities-plan';
import type { ProvisionSettings } from '../provision/model';
import { provisionSettings } from '../provision/settings';

export interface FixturesRun {
  desired: DesiredFixtures;
  state: FixtureState;
  ops: FixtureOp[];
}

/** The approver's UPN: AF_TEST_APPROVER_UPN, or af-approver@<AF_PRIMARY_DOMAIN>. */
export const approverUpnOf = (ctx: Pick<CliContext, 'env'>, settings: ProvisionSettings) =>
  ctx.env.AF_TEST_APPROVER_UPN ||
  (settings.primaryDomain ? `af-approver@${settings.primaryDomain}` : undefined);

/**
 * Read-only: the opted-in fixtures' plan (or removal plan). Undefined when nothing is opted in and no approver is
 * left over (a marked approver is flagged, and removed, whether or not the fixture is opted in).
 */
export async function planFixturesRun(
  ctx: CliContext,
  clients: Clients,
  settings: ProvisionSettings,
  identities: DesiredIdentities,
  mode: 'provision' | 'remove' = 'provision',
): Promise<FixturesRun | undefined> {
  const fixtures = fixtureSettings(ctx.env);
  const desired = buildDesiredFixtures({
    identities,
    settings: fixtures,
    domain: settings.primaryDomain!,
    approverUpn: ctx.env.AF_TEST_APPROVER_UPN || undefined,
    automationWrites: !!settings.allowAutomationWrites,
  });
  const state = await fetchFixtureState(clients.graph, desired, {
    upn: ctx.env.AF_TEST_APPROVER_UPN || undefined,
    password: ctx.env.AF_TEST_APPROVER_PASSWORD || undefined,
  });
  const ops = mode === 'remove' ? planFixtureRemoval(desired, state) : planFixtures(desired, state);
  if (!fixturesEnabled(fixtures) && !ops.length) return undefined;
  return { desired, state, ops };
}

/** The Graph application permissions in the provisioner's app-only token; undefined when no token can be had. */
async function provisionerGraphRoles(
  ctx: CliContext,
  settings: ProvisionSettings,
): Promise<string[] | undefined> {
  try {
    const token = await clientCredentialToken({
      tenantId: settings.tenantId,
      clientId: ctx.env.AF_PROVISIONER_CLIENT_ID ?? '',
      clientSecret: ctx.env.AF_PROVISIONER_CLIENT_SECRET ?? '',
      scope: GRAPH_SCOPE,
      fetch: ctx.fetch,
    })();
    return tokenRoles(token);
  } catch {
    return undefined;
  }
}

/**
 * Hints for opted-in fixtures whose Graph application permission the provisioner's token doesn't carry. Hints, not
 * failures: a directory role can cover some calls; Graph's answer decides (a refusal prints ✗ with the permission).
 */
export async function permissionHints(
  ctx: CliContext,
  settings: ProvisionSettings,
  fixtures: FixtureSettings,
): Promise<string[]> {
  const roles = await provisionerGraphRoles(ctx, settings);
  if (!roles) return [];
  const lines: string[] = [];
  for (const fixture of ['licences', ...FIXTURE_NAMES] as FixtureKey[]) {
    if (!wants(fixtures, fixture)) continue;
    const missing = FIXTURE_PERMISSIONS[fixture].filter((p) => !heldPermission(roles, p));
    if (missing.length)
      lines.push(
        `ℹ "${fixture}": the provisioner's token has no ${missing.join(' / ')} (Microsoft Graph application permission) — if Graph refuses, grant it with admin consent`,
      );
  }
  return lines;
}

/**
 * `provision status`: a ⚠ (never ✗ — they are needed while provisioning) when the provisioner's token holds Graph
 * application permissions that exist only for the test fixtures. They survive removing its directory role, and
 * several are tier-0. Names only.
 */
export async function provisionerStandingLines(
  ctx: CliContext,
  settings: ProvisionSettings,
): Promise<string[]> {
  const roles = await provisionerGraphRoles(ctx, settings);
  if (!roles) return ['⚠ Provisioner: its application permissions could not be read (no token)'];
  const held = standingFixturePermissions(roles);
  return held.length
    ? [
        `⚠ Provisioner holds Microsoft Graph application permissions used only for test fixtures: ${held.join(', ')} — they outlive its directory role and several are tier-0; remove them between provisioning runs (docs/operations.md → The provisioner)`,
      ]
    : ['✓ Provisioner holds no test-fixture application permissions between runs'];
}

/** Prints the fixtures' plan under its own heading (plan view). */
export function printFixturesPlan(run: FixturesRun, out: (line: string) => void): void {
  out('');
  out('Test fixtures (AF_TEST_LICENCE_SKU, AF_TEST_FIXTURES):');
  renderPlan(run.ops, out);
}

/** Applies the fixtures' operations; returns the fixtures that failed (each printed as ✗). */
export function applyFixtures(ctx: CliContext, clients: Clients, run: FixturesRun): Promise<FixtureKey[]> {
  return applyFixtureOps(run.ops, run.desired, run.state, {
    graph: clients.graph,
    writeEnv: ctx.writeEnv,
    log: ctx.out,
    retry: { sleep: ctx.sleep, ...ctx.retry },
    now: ctx.now,
  });
}

/** The ConfigError for fixtures that failed (exit code 1, after everything else was applied). */
export const fixturesFailed = (failed: FixtureKey[]) =>
  new ConfigError(
    `${failed.length} fixture(s) could not be provisioned (${failed.join(', ')}) — see the ✗ lines above; everything else was applied.`,
  );

/** Status lines beyond the checklist: the approver left enabled; strangers in AF-Test-Group-01 (Intune). */
export function fixtureStatusWarnings(run: FixturesRun): string[] {
  const lines: string[] = [];
  if (run.ops.some((o) => o.fixture === 'approver' && o.kind === 'note' && o.detail === 'account enabled'))
    lines.push(
      '⚠ The approver (AF Tester 2) is enabled. Disable it between live runs: `pnpm adminforge provision test-identities --disable`.',
    );
  const members = run.state.testGroupMembers;
  if (wants(run.desired.settings, 'intune') && members && !isUnreadable(members)) {
    const others = unexpectedGroupMembers(members);
    if (others)
      lines.push(
        `⚠ ${run.desired.testGroup.displayName} has ${others} member(s) that aren't provisioning's test accounts or AF-Test-* devices — they receive the AF-Test Intune policies; remove them from the group`,
      );
  }
  return lines;
}

/**
 * `adminforge provision test-identities --remove-fixtures [--dry-run]`: removes what the opted-in fixtures created,
 * and a marked approver in any case. Works in any label (it only removes objects carrying provisioning's marks).
 */
export async function removeTestFixtures(
  ctx: CliContext,
  opts: { dryRun?: boolean } = {},
): Promise<FixturesRun | undefined> {
  const settings = provisionSettings(ctx.env);
  if (!settings.primaryDomain) throw new ConfigError('AF_PRIMARY_DOMAIN must be set in the env file.');
  const clients = provisionerClients(ctx, settings);
  ctx.out(
    `AdminForge provision test-identities --remove-fixtures — environment "${settings.label}"${opts.dryRun ? ' (dry run)' : ''}`,
  );
  const identities = buildDesiredIdentities({
    label: settings.label,
    domain: settings.primaryDomain,
    testerUpn: ctx.env.AF_TEST_USER_UPN,
    approverUpn: approverUpnOf(ctx, settings),
  });
  const run = await planFixturesRun(ctx, clients, settings, identities, 'remove');
  if (!run) {
    ctx.out(
      'No fixture is opted in (AF_TEST_LICENCE_SKU, AF_TEST_FIXTURES) and no approver is left over: nothing to remove. Removal covers the opted-in fixtures (and the approver in any case), so keep the keys set until they are removed.',
    );
    return undefined;
  }
  ctx.out('');
  ctx.out('Plan:');
  renderPlan(run.ops, ctx.out);
  const c = counts(run.ops);
  ctx.out('');
  if (opts.dryRun) ctx.out('Dry run: nothing was changed.');
  else if (c.changes === 0) ctx.out('Nothing to remove.');
  else {
    ctx.out('Removing:');
    const failed = await applyFixtures(ctx, clients, run);
    if (failed.length) throw fixturesFailed(failed);
    ctx.out('');
    ctx.out(
      `Done: ${c.delete} removed. Unset AF_TEST_LICENCE_SKU / AF_TEST_FIXTURES to stop provisioning them again.`,
    );
  }
  return run;
}

/**
 * The approver account's part of `--enable --approver` / `--disable` (provision.ts `setTesterEnabled`). Enabling
 * needs the explicit `--approver` (checked by the caller) and is refused where AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS
 * is true. Disabling always tries: a missing account is reported only when the approver is configured or opted in.
 * Only an account with the approver marker is touched. Returns whether it changed; throws ConfigError on refusal.
 */
export async function setApproverEnabled(
  ctx: CliContext,
  graph: GraphClient,
  settings: ProvisionSettings,
  enabled: boolean,
): Promise<boolean> {
  const configured = !!ctx.env.AF_TEST_APPROVER_UPN || fixtureSettings(ctx.env).fixtures.includes('approver');
  if (enabled && settings.allowAutomationWrites)
    throw new ConfigError(
      'The approver is not enabled where AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true: two-person approval protects scheduled writes here, and one credential file holds both testers.',
    );
  const upn = approverUpnOf(ctx, settings);
  if (!upn) return false;
  const result = await setUserEnabled(graph, upn, enabled, isProvisionedApprover);
  const state = enabled ? 'enabled' : 'disabled';
  if (result === 'refused')
    throw new ConfigError(
      'The account at the approver’s UPN (AF_TEST_APPROVER_UPN) does not carry the approver marker, so it is neither enabled nor disabled here. Fix AF_TEST_APPROVER_UPN.',
    );
  if (result === 'missing') {
    if (enabled || configured)
      ctx.out(
        `Approver (AF_TEST_APPROVER_UPN): does not exist — nothing to ${enabled ? 'enable' : 'disable'}.`,
      );
    return false;
  }
  ctx.out(
    result === 'changed'
      ? `✓ Approver (AF_TEST_APPROVER_UPN): ${state}${enabled ? '' : ', sign-in sessions revoked'}.`
      : `Approver (AF_TEST_APPROVER_UPN): already ${state}.`,
  );
  return result === 'changed';
}
