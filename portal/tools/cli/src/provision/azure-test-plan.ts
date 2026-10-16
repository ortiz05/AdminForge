/**
 * `adminforge provision azure-test` — the Azure side of live KQL validation (R11, R12): a resource group, a
 * small Log Analytics workspace with a hard daily cap, the subscription activity log exported to it, and read
 * access for the automation identity and the validation user. Pure: desired state + fetched state → operations.
 *
 * The desired → plan half of the azure-test pattern; provision/azure-test-io.ts fetches state and applies the
 * operations, commands/azure-test.ts runs the command.
 */
import { AZURE_READER_ROLE_ID, LOG_ANALYTICS_READER_ROLE_ID } from './catalog';
import { appNames } from './entra-desired';
import type { Action, ArmRoleAssignment, Section } from './model';

export const AZURE_TEST_DEFAULT_LOCATION = 'eastus';
/** GB per day; ingestion stops for the day once reached, which bounds the cost of the test workspace. */
export const DAILY_CAP_GB = 0.1;
export const RETENTION_DAYS = 30;
export const WORKSPACE_SKU = 'PerGB2018';
export const ACTIVITY_LOG_CATEGORIES = [
  'Administrative',
  'Policy',
  'Security',
  'ServiceHealth',
  'Alert',
  'Recommendation',
  'ResourceHealth',
] as const;

export const ENV_WORKSPACE_ID = 'AF_LOG_ANALYTICS_WORKSPACE_ID';
export const ENV_LOCATION = 'AF_TEST_LOCATION';

export interface AzureTestSettings {
  label: string;
  subscriptionId: string;
  location: string;
}

export type PrincipalKey = 'automation' | 'tester';

export interface DesiredRole {
  principal: PrincipalKey;
  /** Display label (names only — never ids or UPNs). */
  principalLabel: string;
  principalType: 'ServicePrincipal' | 'User';
  roleName: 'Reader' | 'Log Analytics Reader';
  roleGuid: string;
  /** ARM scope the role is assigned at. */
  scope: string;
  /** Human scope label for output. */
  scopeLabel: string;
}

export interface DesiredAzureTest {
  settings: AzureTestSettings;
  subscriptionScope: string;
  resourceGroup: { name: string; id: string; location: string; tags: Record<string, string> };
  workspace: {
    name: string;
    id: string;
    body: {
      location: string;
      tags: Record<string, string>;
      properties: {
        sku: { name: string };
        retentionInDays: number;
        workspaceCapping: { dailyQuotaGb: number };
        publicNetworkAccessForIngestion: 'Enabled';
        publicNetworkAccessForQuery: 'Enabled';
      };
    };
  };
  diagnostic: { name: string; id: string; categories: readonly string[] };
  roles: DesiredRole[];
}

// ── Fetched state ─────────────────────────────────────────────────────────────

export interface ArmResourceGroup {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string> | null;
}

export interface ArmWorkspace {
  id: string;
  name: string;
  location: string;
  properties?: {
    customerId?: string;
    provisioningState?: string;
    sku?: { name?: string };
    retentionInDays?: number;
    workspaceCapping?: { dailyQuotaGb?: number };
  };
}

export interface ArmDiagnosticSetting {
  id?: string;
  name?: string;
  properties?: {
    workspaceId?: string | null;
    logs?: Array<{ category?: string | null; categoryGroup?: string | null; enabled?: boolean }>;
  };
}

export interface AzureTestState {
  resourceGroup?: ArmResourceGroup;
  workspace?: ArmWorkspace;
  diagnostic?: ArmDiagnosticSetting;
  /** Object ids of the principals that get roles (absent = not found or not configured; see `missing`). */
  principals: Partial<Record<PrincipalKey, string>>;
  /** Why a principal could not be resolved (not configured, not found). */
  missing: Partial<Record<PrincipalKey, string>>;
  /** Role assignments of the principals, keyed by lower-case scope. */
  assignments: Record<string, ArmRoleAssignment[]>;
  env: { workspaceId?: string; location?: string };
}

// ── Plan ──────────────────────────────────────────────────────────────────────

interface Base {
  action: Action;
  section: Section;
  title: string;
  changes?: string[];
  detail?: string;
}

export type AzureTestOp =
  | (Base & { kind: 'resourceGroup' })
  | (Base & { kind: 'workspace' })
  | (Base & { kind: 'diagnosticSetting' })
  | (Base & { kind: 'roleAssignment'; role: DesiredRole })
  | (Base & { kind: 'env'; key: typeof ENV_WORKSPACE_ID | typeof ENV_LOCATION; value?: string })
  | (Base & { kind: 'skipped' });

const lower = (s: string | undefined | null) => (s ?? '').toLowerCase();
const normLocation = (s: string | undefined) => lower(s).replace(/\s+/g, '');

export const roleDefinitionId = (subscriptionScope: string, roleGuid: string) =>
  `${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`;

/** Pure: the desired Azure test environment for one label. */
export function buildDesiredAzureTest(settings: AzureTestSettings): DesiredAzureTest {
  const { label, subscriptionId } = settings;
  const location = normLocation(settings.location) || AZURE_TEST_DEFAULT_LOCATION;
  const sub = `/subscriptions/${subscriptionId}`;
  const rgName = `AF-Test-${label}`;
  const rgId = `${sub}/resourceGroups/${rgName}`;
  const wsName = `af-test-law-${label}`;
  const wsId = `${rgId}/providers/Microsoft.OperationalInsights/workspaces/${wsName}`;
  const tags = {
    'adminforge-env': label,
    'adminforge-purpose': 'kql-validation',
    'managed-by': 'adminforge-cli',
  };
  const automation = `${appNames(label, 'automation').displayName}`;
  const tester = 'Validation user (AF_TEST_USER_UPN)';
  return {
    settings: { ...settings, location },
    subscriptionScope: sub,
    resourceGroup: { name: rgName, id: rgId, location, tags },
    workspace: {
      name: wsName,
      id: wsId,
      body: {
        location,
        tags,
        properties: {
          sku: { name: WORKSPACE_SKU },
          retentionInDays: RETENTION_DAYS,
          workspaceCapping: { dailyQuotaGb: DAILY_CAP_GB },
          publicNetworkAccessForIngestion: 'Enabled',
          publicNetworkAccessForQuery: 'Enabled',
        },
      },
    },
    diagnostic: {
      name: `adminforge-${label}`,
      id: `${sub}/providers/Microsoft.Insights/diagnosticSettings/adminforge-${label}`,
      categories: ACTIVITY_LOG_CATEGORIES,
    },
    roles: [
      {
        principal: 'automation',
        principalLabel: automation,
        principalType: 'ServicePrincipal',
        roleName: 'Log Analytics Reader',
        roleGuid: LOG_ANALYTICS_READER_ROLE_ID,
        scope: wsId,
        scopeLabel: `workspace ${wsName}`,
      },
      {
        principal: 'tester',
        principalLabel: tester,
        principalType: 'User',
        roleName: 'Reader',
        roleGuid: AZURE_READER_ROLE_ID,
        scope: sub,
        scopeLabel: 'subscription (AF_SUBSCRIPTION_ID)',
      },
      {
        principal: 'tester',
        principalLabel: tester,
        principalType: 'User',
        roleName: 'Log Analytics Reader',
        roleGuid: LOG_ANALYTICS_READER_ROLE_ID,
        scope: wsId,
        scopeLabel: `workspace ${wsName}`,
      },
    ],
  };
}

/** Whether the principal holds the role exactly at the scope (inherited assignments don't count: we keep our own). */
export function hasAssignment(state: AzureTestState, role: DesiredRole): boolean {
  const principalId = state.principals[role.principal];
  if (!principalId) return false;
  const suffix = `/roledefinitions/${role.roleGuid}`;
  return (state.assignments[lower(role.scope)] ?? []).some(
    (a) =>
      lower(a.properties.principalId) === lower(principalId) &&
      lower(a.properties.roleDefinitionId).endsWith(suffix) &&
      lower(a.properties.scope) === lower(role.scope),
  );
}

function workspaceDrift(desired: DesiredAzureTest, ws: ArmWorkspace): string[] {
  const p = ws.properties ?? {};
  const want = desired.workspace.body.properties;
  const out: string[] = [];
  if (lower(p.sku?.name) !== lower(want.sku.name))
    out.push(`pricing tier ${p.sku?.name ?? 'unknown'} → ${want.sku.name}`);
  if (p.retentionInDays !== want.retentionInDays)
    out.push(`retention ${p.retentionInDays ?? '?'} → ${want.retentionInDays} days`);
  const cap = p.workspaceCapping?.dailyQuotaGb;
  if (cap === undefined || Math.abs(cap - want.workspaceCapping.dailyQuotaGb) > 1e-9)
    out.push(
      `daily cap ${cap === undefined || cap < 0 ? 'none' : `${cap} GB`} → ${want.workspaceCapping.dailyQuotaGb} GB`,
    );
  return out;
}

function diagnosticDrift(desired: DesiredAzureTest, diag: ArmDiagnosticSetting): string[] {
  const out: string[] = [];
  if (lower(diag.properties?.workspaceId) !== lower(desired.workspace.id))
    out.push('sends to a different workspace');
  const enabled = new Set(
    (diag.properties?.logs ?? []).filter((l) => l.enabled).map((l) => lower(l.category)),
  );
  const missing = desired.diagnostic.categories.filter((c) => !enabled.has(lower(c)));
  if (missing.length) out.push(`categories missing: ${missing.join(', ')}`);
  return out;
}

/** Pure: desired + fetched → ordered operations (resource group, workspace, export, roles, env file). */
export function planAzureTest(desired: DesiredAzureTest, state: AzureTestState): AzureTestOp[] {
  const ops: AzureTestOp[] = [];
  const rg = desired.resourceGroup;
  const ws = desired.workspace;
  const loc = desired.settings.location;

  if (!state.resourceGroup)
    ops.push({
      kind: 'resourceGroup',
      action: 'create',
      section: 'Azure test environment',
      title: `Resource group ${rg.name} (${loc})`,
    });
  else
    ops.push({
      kind: 'resourceGroup',
      action: 'noop',
      section: 'Azure test environment',
      title: `Resource group ${rg.name} (${state.resourceGroup.location})`,
      ...(normLocation(state.resourceGroup.location) !== loc
        ? {
            detail: `exists in ${state.resourceGroup.location}; a resource group cannot move (AF_TEST_LOCATION is ${loc})`,
          }
        : {}),
    });

  const wsTitle = `Log Analytics workspace ${ws.name} (${WORKSPACE_SKU}, ${RETENTION_DAYS}-day retention, daily cap ${DAILY_CAP_GB} GB)`;
  if (!state.workspace)
    ops.push({ kind: 'workspace', action: 'create', section: 'Azure test environment', title: wsTitle });
  else if (normLocation(state.workspace.location) !== normLocation(ws.body.location))
    ops.push({
      kind: 'skipped',
      action: 'skip',
      section: 'Azure test environment',
      title: wsTitle,
      changes: [
        `exists in ${state.workspace.location}, not ${ws.body.location}; run with --destroy first to move it`,
      ],
    });
  else {
    const drift = workspaceDrift(desired, state.workspace);
    ops.push({
      kind: 'workspace',
      action: drift.length ? 'update' : 'noop',
      section: 'Azure test environment',
      title: wsTitle,
      ...(drift.length ? { changes: drift } : {}),
    });
  }

  const diagTitle = `Subscription activity log → ${ws.name} (diagnostic setting ${desired.diagnostic.name}: ${desired.diagnostic.categories.join(', ')})`;
  if (!state.diagnostic)
    ops.push({
      kind: 'diagnosticSetting',
      action: 'create',
      section: 'Activity log export',
      title: diagTitle,
    });
  else {
    const drift = diagnosticDrift(desired, state.diagnostic);
    ops.push({
      kind: 'diagnosticSetting',
      action: drift.length ? 'update' : 'noop',
      section: 'Activity log export',
      title: diagTitle,
      ...(drift.length ? { changes: drift } : {}),
    });
  }

  for (const role of desired.roles) {
    const title = `${role.principalLabel} → ${role.roleName} on ${role.scopeLabel}`;
    const why = state.missing[role.principal];
    if (why) ops.push({ kind: 'skipped', action: 'skip', section: 'Azure RBAC', title, changes: [why] });
    else
      ops.push({
        kind: 'roleAssignment',
        action: hasAssignment(state, role) ? 'noop' : 'create',
        section: 'Azure RBAC',
        title,
        role,
      });
  }

  const customerId = state.workspace?.properties?.customerId;
  const wsEnvOk = !!customerId && lower(state.env.workspaceId) === lower(customerId);
  ops.push({
    kind: 'env',
    key: ENV_WORKSPACE_ID,
    action: wsEnvOk ? 'noop' : state.env.workspaceId ? 'update' : 'create',
    section: 'Env file',
    title: `${ENV_WORKSPACE_ID} (workspace id of ${ws.name})`,
    ...(customerId ? { value: customerId } : {}),
    ...(!wsEnvOk && state.env.workspaceId ? { changes: ['points at a different workspace'] } : {}),
  });
  const locEnvOk = normLocation(state.env.location) === loc;
  ops.push({
    kind: 'env',
    key: ENV_LOCATION,
    action: locEnvOk ? 'noop' : state.env.location ? 'update' : 'create',
    section: 'Env file',
    title: `${ENV_LOCATION} (${loc})`,
    value: loc,
  });
  return ops;
}

/** True when nothing of the test environment exists yet (status shows one hint instead of a list of ✗). */
export const notProvisioned = (state: AzureTestState) =>
  !state.resourceGroup && !state.workspace && !state.diagnostic && !state.env.workspaceId;
