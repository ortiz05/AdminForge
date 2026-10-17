/**
 * The `intune-more` test fixture: more Intune policies for the endpoint pages and reports — iOS and Android
 * compliance policies, a macOS one left unassigned (the "policy assigned to nobody" finding), a Windows update ring,
 * and iOS and Android app protection policies. Harmless settings; every assigned one targets AF-Test-Group-01 only.
 * Same ownership rule as the `intune` fixture: an AF-Test name and the marker in the description; a same-named policy
 * without it is refused. Plan (pure) and Graph I/O in one module.
 */
import { type GraphClient, ApiError } from '@adminforge/connectors';
import { findGroup } from './entra-io';
import {
  FIXTURE_DESCRIPTION,
  GROUP_TARGET,
  isProvisionedPolicy,
  isProvisionedTestGroup,
  isUnreadable,
  type DesiredFixtures,
  type FixtureOp,
  type IntunePolicyState,
  type Unreadable,
} from './fixtures-model';

export const INTUNE_MORE_SECTION = 'Test fixtures: more Intune policies';

/** The policy needs `scheduledActionsForRule` on create (mark non-compliant, Intune's default). */
const BLOCK_ACTION = [
  {
    ruleName: 'PasswordRequired',
    scheduledActionConfigurations: [
      { actionType: 'block', gracePeriodHours: 0, notificationTemplateId: '', notificationMessageCCList: [] },
    ],
  },
];

export type IntuneMoreKey =
  'ios' | 'android' | 'macos' | 'updateRing' | 'iosAppProtection' | 'androidAppProtection';

export interface IntuneMoreSpec {
  key: IntuneMoreKey;
  path: string;
  displayName: string;
  kind: string;
  /** Assigned to AF-Test-Group-01; false = kept unassigned. */
  assigned: boolean;
  body: Record<string, unknown>;
}

const spec = (
  key: IntuneMoreKey,
  path: string,
  displayName: string,
  kind: string,
  assigned: boolean,
  body: Record<string, unknown>,
): IntuneMoreSpec => ({
  key,
  path,
  displayName,
  kind,
  assigned,
  body: { displayName, description: FIXTURE_DESCRIPTION, ...body },
});

export const INTUNE_MORE: readonly IntuneMoreSpec[] = [
  spec(
    'ios',
    '/deviceManagement/deviceCompliancePolicies',
    'AF-Test Compliance (iOS)',
    'iOS compliance',
    true,
    {
      '@odata.type': '#microsoft.graph.iosCompliancePolicy',
      securityBlockJailbrokenDevices: true,
      scheduledActionsForRule: BLOCK_ACTION,
    },
  ),
  spec(
    'android',
    '/deviceManagement/deviceCompliancePolicies',
    'AF-Test Compliance (Android)',
    'Android work profile compliance',
    true,
    {
      '@odata.type': '#microsoft.graph.androidWorkProfileCompliancePolicy',
      securityBlockJailbrokenDevices: true,
      scheduledActionsForRule: BLOCK_ACTION,
    },
  ),
  spec(
    'macos',
    '/deviceManagement/deviceCompliancePolicies',
    'AF-Test Compliance (macOS)',
    'macOS compliance, unassigned',
    false,
    {
      '@odata.type': '#microsoft.graph.macOSCompliancePolicy',
      firewallEnabled: true,
      scheduledActionsForRule: BLOCK_ACTION,
    },
  ),
  spec(
    'updateRing',
    '/deviceManagement/deviceConfigurations',
    'AF-Test Update ring (Windows)',
    'Windows update ring',
    true,
    {
      '@odata.type': '#microsoft.graph.windowsUpdateForBusinessConfiguration',
      automaticUpdateMode: 'autoInstallAtMaintenanceTime',
      businessReadyUpdatesOnly: 'userDefined',
      deliveryOptimizationMode: 'userDefined',
      prereleaseFeatures: 'userDefined',
      microsoftUpdateServiceAllowed: true,
      driversExcluded: false,
      qualityUpdatesDeferralPeriodInDays: 3,
      featureUpdatesDeferralPeriodInDays: 30,
      qualityUpdatesPaused: false,
      featureUpdatesPaused: false,
      skipChecksBeforeRestart: false,
      installationSchedule: {
        '@odata.type': '#microsoft.graph.windowsUpdateActiveHoursInstall',
        activeHoursStart: '08:00:00.0000000',
        activeHoursEnd: '17:00:00.0000000',
      },
    },
  ),
  spec(
    'iosAppProtection',
    '/deviceAppManagement/iosManagedAppProtections',
    'AF-Test App protection (iOS)',
    'iOS app protection',
    true,
    {},
  ),
  spec(
    'androidAppProtection',
    '/deviceAppManagement/androidManagedAppProtections',
    'AF-Test App protection (Android)',
    'Android app protection',
    true,
    {},
  ),
];

export interface IntuneMoreState {
  policies: Partial<Record<IntuneMoreKey, IntunePolicyState[]>>;
  /** AF-Test-Group-01's id when it exists and is the one the test identities created; `foreign` when it isn't. */
  testGroupId?: string;
  testGroupForeign?: boolean;
}

export type IntuneMoreStep =
  | { op: 'policy'; key: IntuneMoreKey; existingId?: string }
  | { op: 'delete'; key: IntuneMoreKey; id: string };

// Each operation resolves what it needs and fails on its own: one refusal doesn't stop the others.
const base = { fixture: 'intune-more', section: INTUNE_MORE_SECTION, independent: true } as const;
const blocked = (title: string, why: string): FixtureOp => ({
  ...base,
  kind: 'note',
  action: 'skip',
  blocked: true,
  title,
  changes: [why],
});

/** Whether a policy's assignments are exactly what the catalogue wants (AF-Test-Group-01 only, or none). */
const assignedAsWanted = (p: IntunePolicyState, s: IntuneMoreSpec, groupId: string | undefined) =>
  s.assigned
    ? !!groupId &&
      p.targets.length === 1 &&
      p.targets[0]!.type === GROUP_TARGET &&
      p.targets[0]!.groupId === groupId
    : p.targets.length === 0;

/**
 * Pure: the intune-more fixture's operations. `groupProblem` (fixtures-model `testGroupProblem`): why AF-Test-Group-01
 * can't receive policies now (strangers in it, dynamic membership) — the assigned policies are refused then, as the
 * group-scoped audit policies are, because whoever is in the group would get them.
 */
export function planIntuneMore(
  d: DesiredFixtures,
  s: IntuneMoreState | Unreadable | undefined,
  remove: boolean,
  groupProblem?: string,
): FixtureOp[] {
  if (isUnreadable(s)) return [blocked('More AF-Test Intune policies', s.unreadable)];
  if (!s) return [];
  const groupRefusal = s.testGroupForeign
    ? `the group at ${d.testGroup.displayName}'s unique name isn't the one provisioning created — left alone`
    : groupProblem;
  const ops: FixtureOp[] = [];
  for (const p of INTUNE_MORE) {
    const title = `${p.displayName} (${p.kind})${p.assigned ? ` → ${d.testGroup.displayName}` : ''}`;
    const same = (s.policies[p.key] ?? []).filter((x) => x.displayName === p.displayName);
    const ours = same.find(isProvisionedPolicy);
    if (remove) {
      for (const x of same.filter(isProvisionedPolicy))
        ops.push({
          ...base,
          kind: 'intuneMore',
          action: 'delete',
          title,
          step: { op: 'delete', key: p.key, id: x.id },
        });
      continue;
    }
    if (!ours && same.length) {
      ops.push(
        blocked(
          title,
          'a policy with this name exists without the marker in its description — not created by provisioning, left alone',
        ),
      );
      continue;
    }
    if (p.assigned && groupRefusal) {
      ops.push(blocked(title, groupRefusal));
      continue;
    }
    if (!ours) {
      ops.push({
        ...base,
        kind: 'intuneMore',
        action: 'create',
        title,
        step: { op: 'policy', key: p.key },
        ...(p.assigned && !s.testGroupId ? { changes: [`after ${d.testGroup.displayName} is created`] } : {}),
      });
      continue;
    }
    ops.push(
      assignedAsWanted(ours, p, s.testGroupId)
        ? { ...base, kind: 'note', action: 'noop', title }
        : {
            ...base,
            kind: 'intuneMore',
            action: 'update',
            title,
            step: { op: 'policy', key: p.key, existingId: ours.id },
            changes: [p.assigned ? `assign to ${d.testGroup.displayName} only` : 'remove its assignments'],
          },
    );
  }
  return ops;
}

/** Reads the policies with the catalogue's names and their assignment targets. Read-only. */
export async function readIntuneMoreState(graph: GraphClient, d: DesiredFixtures): Promise<IntuneMoreState> {
  const state: IntuneMoreState = { policies: {} };
  const lists = new Map<string, Array<{ id: string; displayName: string; description?: string | null }>>();
  for (const p of INTUNE_MORE) {
    if (!lists.has(p.path))
      lists.set(p.path, await graph.all({ path: p.path, query: { $select: 'id,displayName,description' } }));
    state.policies[p.key] = [];
    for (const x of lists.get(p.path)!.filter((x) => x.displayName === p.displayName)) {
      const assignments = isProvisionedPolicy(x)
        ? await graph.all<{ target?: { '@odata.type'?: string; groupId?: string } }>({
            path: `${p.path}/${x.id}/assignments`,
          })
        : [];
      state.policies[p.key]!.push({
        ...x,
        targets: assignments.map((a) => ({
          type: a.target?.['@odata.type'] ?? 'unknown',
          ...(a.target?.groupId ? { groupId: a.target.groupId } : {}),
        })),
      });
    }
  }
  const group = await findGroup(graph, d.testGroup.uniqueName);
  if (group && isProvisionedTestGroup(d, group)) state.testGroupId = group.id;
  else if (group) state.testGroupForeign = true;
  return state;
}

/**
 * Applies one operation: create (or keep) the policy, then set its assignments (`assign` replaces them all).
 * `testGroupId` resolves AF-Test-Group-01 and refuses a group the test identities didn't create.
 */
export async function applyIntuneMoreStep(
  s: IntuneMoreStep,
  title: string,
  ctx: { graph: GraphClient; log: (line: string) => void; testGroupId: () => Promise<string> },
): Promise<void> {
  const { graph, log } = ctx;
  const p = INTUNE_MORE.find((x) => x.key === s.key)!;
  if (s.op === 'delete') {
    try {
      await graph.request({ method: 'DELETE', path: `${p.path}/${s.id}` });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    log(`  ✓ removed: ${title}`);
    return;
  }
  const id =
    s.existingId ??
    (await graph.request<{ id: string }>({ method: 'POST', path: p.path, body: p.body })).data.id;
  const assignments = p.assigned
    ? [{ target: { '@odata.type': GROUP_TARGET, groupId: await ctx.testGroupId() } }]
    : [];
  await graph.request({ method: 'POST', path: `${p.path}/${id}/assign`, body: { assignments } });
  log(
    `  ✓ ${s.existingId ? 'assigned' : p.assigned ? 'created and assigned' : 'created (unassigned)'}: ${title}`,
  );
}
