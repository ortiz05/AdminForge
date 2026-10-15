import { ApiError, createLogAnalyticsClient } from '@adminforge/connectors';
import {
  appClients,
  ConfigError,
  provisionerClients,
  provisionSettings,
  type CliContext,
  type Clients,
} from '../commands/context';
import { clientCredentialToken, TokenError } from './auth';
import { ENV_KEYS } from './entra-desired';
import { ARM_BASE } from './entra-io';
import { isGuid } from './ids';
import { counts, renderPlan, renderStatus } from './render';
import {
  AZURE_TEST_DEFAULT_LOCATION,
  buildDesiredAzureTest,
  DAILY_CAP_GB,
  ENV_LOCATION,
  ENV_WORKSPACE_ID,
  notProvisioned,
  planAzureTest,
  type AzureTestOp,
  type AzureTestSettings,
  type AzureTestState,
  type DesiredAzureTest,
} from './azure-test-plan';
import {
  API,
  applyAzureTestOps,
  destroyAzureTest,
  fetchAzureTestState,
  resolvePrincipals,
  type DestroyResult,
} from './azure-test-io';

export const LOG_ANALYTICS_SCOPE = 'https://api.loganalytics.io/.default';

export function azureTestSettings(env: CliContext['env']): AzureTestSettings {
  const base = provisionSettings(env);
  if (!base.subscriptionId)
    throw new ConfigError(
      'AF_SUBSCRIPTION_ID must be set in the env file (the subscription that holds the test environment).',
    );
  const location = (env[ENV_LOCATION] || AZURE_TEST_DEFAULT_LOCATION).toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z][a-z0-9]{2,30}$/.test(location))
    throw new ConfigError(`${ENV_LOCATION} must be an Azure region name such as eastus or westeurope.`);
  return { label: base.label, subscriptionId: base.subscriptionId, location };
}

export interface AzureTestRun {
  desired: DesiredAzureTest;
  state: AzureTestState;
  ops: AzureTestOp[];
}

/** Read-only: desired → fetch → plan. */
export async function planAzureTestRun(
  ctx: CliContext,
  clients: Clients,
  settings = azureTestSettings(ctx.env),
): Promise<AzureTestRun> {
  const desired = buildDesiredAzureTest(settings);
  const state = await fetchAzureTestState(clients.arm, clients.graph, desired, {
    automationClientId: ctx.env[ENV_KEYS.automation.clientId] || undefined,
    testerUpn: ctx.env.AF_TEST_USER_UPN || undefined,
    env: {
      workspaceId: ctx.env[ENV_WORKSPACE_ID] || undefined,
      location: ctx.env[ENV_LOCATION] || undefined,
    },
  });
  return { desired, state, ops: planAzureTest(desired, state) };
}

// ── Live check: the automation identity queries the workspace ─────────────────

export interface VerifyResult {
  ok: boolean;
  /** Rows in AzureActivity over the last day (null when the table does not exist yet). */
  activityRows?: number | null;
  error?: string;
}

/** Errors that mean "not yet": new workspace still provisioning, or the role assignment still propagating. */
const notYet = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 401 ||
    err.status === 403 ||
    err.status === 404 ||
    /InsufficientAccess|WorkspaceNotFound|PathNotFound|Authorization/i.test(err.code));

const describe = (err: unknown) =>
  err instanceof ApiError
    ? `${err.status} ${err.code}: ${err.message.split('\n')[0]}`
    : err instanceof TokenError
      ? `${err.aadsts ?? err.error}`
      : String(err);

/**
 * Runs `print ok = 1` (answers even in an empty workspace) and an AzureActivity count as the automation identity.
 * Azure RBAC can take a few minutes to reach Log Analytics, so "not yet" errors are retried.
 */
export async function verifyWorkspace(
  ctx: CliContext,
  settings: AzureTestSettings & { tenantId: string },
  workspaceId: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<VerifyResult> {
  const clientId = ctx.env[ENV_KEYS.automation.clientId];
  const clientSecret = ctx.env[ENV_KEYS.automation.secret];
  if (!isGuid(clientId) || !clientSecret)
    return {
      ok: false,
      error: `${ENV_KEYS.automation.clientId} / ${ENV_KEYS.automation.secret} are not in the env file`,
    };
  const la = createLogAnalyticsClient({
    getToken: clientCredentialToken({
      tenantId: settings.tenantId,
      clientId,
      clientSecret,
      scope: LOG_ANALYTICS_SCOPE,
      fetch: ctx.fetch,
    }),
    fetch: ctx.fetch,
    sleep: ctx.sleep,
    timeoutMs: 60_000,
  });
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 20;
  const interval = opts.intervalMs ?? 15_000;
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await la.query({ workspace: workspaceId, query: 'print ok = 1' });
      if (r.rows[0]?.ok !== 1) return { ok: false, error: 'print returned an unexpected result' };
      let activityRows: number | null = null;
      try {
        const a = await la.query({
          workspace: workspaceId,
          query: 'AzureActivity | summarize rows = count()',
          timespan: 'P1D',
        });
        activityRows = typeof a.rows[0]?.rows === 'number' ? (a.rows[0].rows as number) : 0;
      } catch (err) {
        // The table appears with the first exported event (up to ~15 minutes after the export is created).
        if (!(err instanceof ApiError) || err.status !== 400) throw err;
      }
      return { ok: true, activityRows };
    } catch (err) {
      lastError = err;
      if (!notYet(err) || i === attempts) break;
      if (i === 1)
        ctx.out(
          '      … waiting for the role assignment to reach Log Analytics (this can take a few minutes)',
        );
      await sleep(interval);
    }
  }
  return { ok: false, error: describe(lastError) };
}

function verifyLines(ctx: CliContext, workspaceName: string, v: VerifyResult, indent = '  ') {
  if (!v.ok) {
    ctx.out(`${indent}✗ Automation identity can query ${workspaceName} — ${v.error}`);
    return;
  }
  ctx.out(`${indent}✓ Automation identity can query ${workspaceName} (print ok = 1 answered)`);
  ctx.out(
    v.activityRows === null || v.activityRows === undefined
      ? `${indent}  ℹ AzureActivity has no data yet — the activity log export starts within about 15 minutes`
      : `${indent}  ℹ AzureActivity: ${v.activityRows} row${v.activityRows === 1 ? '' : 's'} in the last 24 hours`,
  );
}

// ── Commands ──────────────────────────────────────────────────────────────────

function printSkipped(ctx: CliContext, ops: AzureTestOp[]) {
  const skipped = ops.filter((o) => o.action === 'skip');
  if (!skipped.length) return;
  ctx.out('');
  ctx.out('Not provisioned here:');
  for (const s of skipped) ctx.out(`  ⚠ ${s.title} — ${s.changes?.join(', ') ?? 'skipped'}`);
}

/** `adminforge provision azure-test [--dry-run] [--no-verify]` */
export async function provisionAzureTest(
  ctx: CliContext,
  opts: { dryRun?: boolean; verify?: boolean; verifyAttempts?: number } = {},
): Promise<AzureTestRun & { verify?: VerifyResult }> {
  const settings = azureTestSettings(ctx.env);
  const base = provisionSettings(ctx.env);
  const clients = provisionerClients(ctx, base);
  ctx.out(
    `AdminForge provision azure-test — environment "${settings.label}", location ${settings.location}${opts.dryRun ? ' (dry run)' : ''}`,
  );
  const run = await planAzureTestRun(ctx, clients, settings);
  ctx.out('');
  ctx.out('Plan:');
  renderPlan(run.ops, ctx.out);
  const c = counts(run.ops);
  ctx.out('');
  if (opts.dryRun) {
    ctx.out('Dry run: nothing was changed.');
    printSkipped(ctx, run.ops);
    return run;
  }
  if (c.create + c.update === 0) ctx.out('Nothing to do: everything is already in the desired state.');
  else {
    ctx.out('Applying:');
    await applyAzureTestOps(run.ops, run.desired, run.state, {
      arm: clients.arm,
      writeEnv: ctx.writeEnv,
      log: ctx.out,
      retry: { sleep: ctx.sleep, ...ctx.retry },
      sleep: ctx.sleep,
    });
    ctx.out('');
    ctx.out(
      `Done: ${c.create} created, ${c.update} updated, ${c.noop} unchanged, ${c.skip} skipped. Ingestion is capped at ${DAILY_CAP_GB} GB a day.`,
    );
  }
  printSkipped(ctx, run.ops);
  if (opts.verify === false) return run;
  const workspaceId = ctx.env[ENV_WORKSPACE_ID];
  if (!isGuid(workspaceId)) return run;
  ctx.out('');
  ctx.out('Check:');
  const verify = await verifyWorkspace(ctx, { ...settings, tenantId: base.tenantId }, workspaceId, {
    attempts: opts.verifyAttempts,
  });
  verifyLines(ctx, run.desired.workspace.name, verify);
  return { ...run, verify };
}

/** `adminforge provision azure-test --destroy [--yes]` */
export async function destroyAzureTestRun(
  ctx: CliContext,
  opts: {
    yes?: boolean;
    confirm?: (question: string) => Promise<string>;
    poll?: { attempts?: number; intervalMs?: number };
  } = {},
): Promise<DestroyResult | null> {
  const settings = azureTestSettings(ctx.env);
  const base = provisionSettings(ctx.env);
  const clients = provisionerClients(ctx, base);
  const desired = buildDesiredAzureTest(settings);
  ctx.out(`AdminForge provision azure-test --destroy — environment "${settings.label}"`);
  ctx.out('');
  ctx.out('This deletes:');
  ctx.out(
    `  - resource group ${desired.resourceGroup.name} and everything in it (Log Analytics workspace ${desired.workspace.name}, its data and role assignments)`,
  );
  ctx.out(`  - subscription diagnostic setting ${desired.diagnostic.name} (activity log export)`);
  ctx.out('  - the validation user’s Reader assignment on the subscription that provisioning created');
  ctx.out('');
  if (!opts.yes) {
    if (!opts.confirm)
      throw new ConfigError('Refusing to delete without confirmation: run interactively, or pass --yes.');
    const answer = (await opts.confirm(`Type ${desired.resourceGroup.name} to delete it: `)).trim();
    if (answer !== desired.resourceGroup.name) {
      ctx.out('Nothing was deleted.');
      return null;
    }
  }
  const ws = await clients.arm
    .send<{ properties?: { customerId?: string } }>({
      url: `${ARM_BASE}${desired.workspace.id}?api-version=${API.workspaces}`,
    })
    .then((r) => r.data.properties?.customerId)
    .catch(() => undefined);
  const { principals } = await resolvePrincipals(
    clients.graph,
    {
      automationClientId: ctx.env[ENV_KEYS.automation.clientId] || undefined,
      testerUpn: ctx.env.AF_TEST_USER_UPN || undefined,
    },
    { automation: desired.roles[0]!.principalLabel },
  );
  ctx.out('Deleting:');
  const result = await destroyAzureTest(clients.arm, desired, principals, {
    log: ctx.out,
    sleep: ctx.sleep,
    poll: opts.poll,
  });
  if (ws && (ctx.env[ENV_WORKSPACE_ID] ?? '').toLowerCase() === ws.toLowerCase()) {
    ctx.writeEnv({ [ENV_WORKSPACE_ID]: '' });
    ctx.out(`  ✓ cleared ${ENV_WORKSPACE_ID} in the env file`);
  }
  return result;
}

/** The Azure test environment block of `adminforge provision status`. Optional: absent means "not provisioned", not failure. */
export async function azureTestStatus(
  ctx: CliContext,
  clients: Clients,
): Promise<{ failures: string[]; ops: AzureTestOp[] }> {
  let settings: AzureTestSettings;
  try {
    settings = azureTestSettings(ctx.env);
  } catch (err) {
    ctx.out(`  ⚠ Azure test environment — ${err instanceof Error ? err.message : String(err)}`);
    return { failures: [], ops: [] };
  }
  let run: AzureTestRun;
  try {
    run = await planAzureTestRun(ctx, clients, settings);
  } catch (err) {
    ctx.out(`  ⚠ Azure test environment — could not be read (${describe(err)})`);
    return { failures: [], ops: [] };
  }
  if (notProvisioned(run.state)) {
    ctx.out(
      '  ℹ Azure test environment — not provisioned (optional; `pnpm adminforge provision azure-test` creates it)',
    );
    return { failures: [], ops: [] };
  }
  renderStatus(run.ops, ctx.out);
  const failures = run.ops.filter((o) => o.action === 'create' || o.action === 'update').map((o) => o.title);
  const workspaceId = ctx.env[ENV_WORKSPACE_ID];
  const automation = appClients(ctx, provisionSettings(ctx.env), 'automation');
  if (isGuid(workspaceId) && automation) {
    const v = await verifyWorkspace(
      ctx,
      { ...settings, tenantId: provisionSettings(ctx.env).tenantId },
      workspaceId,
      { attempts: 1 },
    );
    verifyLines(ctx, run.desired.workspace.name, v, '    ');
    if (!v.ok) failures.push(`Automation identity can query ${run.desired.workspace.name}`);
  }
  return { failures, ops: run.ops };
}
