import { ApiError, type Provenance } from '@adminforge/connectors';
import { odataLiteral } from '@adminforge/expressions';
import type { SessionRecord } from '../auth/session-store';
import type { ErrorInfo } from '../datasources/executor';
import { errorHint } from '../execution/outbound';
import type { OutboundExecutor } from '../execution/types';
import { featureStates, type FeatureKey, type FeatureState } from './features';
import { parseSubscribedSkus, type TenantSku } from './licences';

/** One directory role held (active) or eligible (PIM) by the signed-in user. `id` = role definition id. */
export interface DirectoryRoleInfo {
  id: string;
  displayName: string;
  /** "/" = tenant-wide; otherwise an administrative unit or app scope. */
  directoryScopeId: string;
  /** Direct | Group (inherited through a role-assignable group). */
  memberType?: string;
  /** Assigned | Activated (PIM). */
  assignmentType?: string;
  startDateTime?: string | null;
  endDateTime?: string | null;
}

/** GET /api/me/capabilities */
export interface CapabilitiesResponse {
  roles: {
    /** Empty when they could not be read (see errors.active). */
    active: DirectoryRoleInfo[];
    /** Empty without Entra ID P2 or permission (see eligibleAvailable / errors.eligible). */
    eligible: DirectoryRoleInfo[];
    /** false when PIM eligibility could not be read (no P2 or no permission) — hide "Activate in PIM". */
    eligibleAvailable: boolean;
    /** pim = roleAssignmentScheduleInstances; assignments = roleAssignments (fallback without P2). */
    activeSource: 'pim' | 'assignments' | null;
  };
  features: Record<FeatureKey, FeatureState>;
  skus: Array<Pick<TenantSku, 'skuPartNumber' | 'capabilityStatus' | 'enabled' | 'consumed'>>;
  errors?: Partial<Record<'active' | 'eligible' | 'skus', ErrorInfo>>;
  provenance: Provenance;
}

interface RawAssignment {
  roleDefinitionId?: string;
  directoryScopeId?: string;
  memberType?: string;
  assignmentType?: string;
  startDateTime?: string | null;
  endDateTime?: string | null;
  roleDefinition?: { displayName?: string };
}

const toRoles = (body: unknown): DirectoryRoleInfo[] =>
  ((body as { value?: RawAssignment[] } | undefined)?.value ?? [])
    .map((r) => ({
      id: r.roleDefinitionId ?? '',
      displayName: r.roleDefinition?.displayName ?? r.roleDefinitionId ?? 'Unknown role',
      directoryScopeId: r.directoryScopeId ?? '/',
      ...(r.memberType ? { memberType: r.memberType } : {}),
      ...(r.assignmentType ? { assignmentType: r.assignmentType } : {}),
      ...(r.startDateTime !== undefined ? { startDateTime: r.startDateTime } : {}),
      ...(r.endDateTime !== undefined ? { endDateTime: r.endDateTime } : {}),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

/**
 * Roles and licensed features for the signed-in user in one Graph `$batch` (read mode, the user's own token):
 * active roles (PIM schedule instances, falling back to plain role assignments without P2), PIM-eligible roles
 * (degrade to null without P2), and tenant licences from subscribedSkus → feature map with the enabling SKU.
 */
export async function loadCapabilities(
  outbound: OutboundExecutor,
  session: SessionRecord,
  correlationId: string,
): Promise<CapabilitiesResponse> {
  const who = `principalId eq ${odataLiteral(session.userOid)}`;
  const expand = 'roleDefinition($select=displayName)';
  const requests = [
    {
      id: 'active',
      path: '/roleManagement/directory/roleAssignmentScheduleInstances',
      query: { $filter: who, $expand: expand },
    },
    {
      id: 'eligible',
      path: '/roleManagement/directory/roleEligibilityScheduleInstances',
      query: { $filter: who, $expand: expand },
    },
    {
      id: 'assignments',
      path: '/roleManagement/directory/roleAssignments',
      query: { $filter: who, $expand: expand },
    },
    { id: 'skus', path: '/subscribedSkus' },
  ];
  const identity = { kind: 'delegated' as const, session, mode: 'read' as const };
  const res = await outbound.execute<{ responses: Array<{ id: string; status: number; body: unknown }> }>(
    identity,
    {
      service: 'graph',
      method: 'POST',
      path: '/$batch',
      body: { requests },
      pathTemplate: '/$batch',
      requires: { licences: ['AAD_PREMIUM_P2'] },
    },
    { correlationId },
  );
  const byId = new Map(res.data.responses.map((r) => [r.id, r]));
  const errors: NonNullable<CapabilitiesResponse['errors']> = {};
  const ok = (id: string) => {
    const r = byId.get(id);
    return r && r.status >= 200 && r.status < 300 ? r.body : undefined;
  };
  const fail = (id: string, licenceHint?: string): ErrorInfo => {
    const r = byId.get(id);
    const e = (r?.body as { error?: { code?: string; message?: string } } | undefined)?.error;
    const err = new ApiError(
      r?.status ?? 0,
      e?.code ?? `HTTP${r?.status ?? 0}`,
      e?.message ?? 'No response.',
    );
    const { hint, licence } = errorHint(err, 'graph', identity, {
      scopes: { graph: ['RoleManagement.Read.Directory'] },
    });
    return {
      code: licence ? 'licence_required' : err.code,
      message: err.message,
      hint: licence && licenceHint ? licenceHint : hint,
    };
  };

  const skuBody = ok('skus');
  const licences = skuBody !== undefined ? parseSubscribedSkus(skuBody) : null;
  if (skuBody === undefined) errors.skus = fail('skus');

  let active: DirectoryRoleInfo[] = [];
  let activeSource: CapabilitiesResponse['roles']['activeSource'] = null;
  if (ok('active') !== undefined) {
    active = toRoles(ok('active'));
    activeSource = 'pim';
  } else if (ok('assignments') !== undefined) {
    active = toRoles(ok('assignments'));
    activeSource = 'assignments';
  } else errors.active = fail('assignments');

  let eligible: DirectoryRoleInfo[] = [];
  const eligibleAvailable = ok('eligible') !== undefined;
  if (eligibleAvailable) eligible = toRoles(ok('eligible'));
  else
    errors.eligible = fail(
      'eligible',
      'PIM eligibility needs Microsoft Entra ID P2 (AAD_PREMIUM_P2) in the tenant.',
    );

  return {
    roles: { active, eligible, eligibleAvailable, activeSource },
    features: featureStates(licences),
    skus: (licences?.skus ?? []).map(({ skuPartNumber, capabilityStatus, enabled, consumed }) => ({
      skuPartNumber,
      capabilityStatus,
      enabled,
      consumed,
    })),
    ...(Object.keys(errors).length ? { errors } : {}),
    provenance: res.provenance,
  };
}
