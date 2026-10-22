import { describe, expect, it } from 'vitest';
import { ceilingFor } from '@adminforge/cli/src/provision/entra-desired';
import { isPrivilegedAppRole, isPrivilegedDelegatedScope } from '@adminforge/cli/src/provision/privilege';

// Decided 2026-10-22 (owner): these application permissions are tier 0 for app-only identities — Conditional Access
// and sign-in inputs, token-issuance hooks, app proxy, multi-tenant organizations, SharePoint tenant settings,
// administrative units, the Intune cloud CA, sign-in identities, PIM alerts and removals, agent identities. The
// automation identity and named identities get them only with the tier-0 opt-in; the Write app's delegated scopes
// are unchanged (UserAuthenticationMethod.ReadWrite.All stays an ordinary write scope there).
const DECIDED = [
  'Device.ReadWrite.All',
  'CustomSecAttributeAssignment.ReadWrite.All',
  'IdentityRiskyUser.ReadWrite.All',
  'EventListener.ReadWrite.All',
  'CustomAuthenticationExtension.ReadWrite.All',
  'OnPremisesPublishingProfiles.ReadWrite.All',
  'MultiTenantOrganization.ReadWrite.All',
  'SharePointTenantSettings.ReadWrite.All',
  'AdministrativeUnit.ReadWrite.All',
  'DeviceManagementCloudCA.ReadWrite.All',
  'User.ManageIdentities.All',
  'RoleManagementAlert.ReadWrite.Directory',
  'RoleAssignmentSchedule.Remove.Directory',
  'RoleEligibilitySchedule.Remove.Directory',
  'PrivilegedAssignmentSchedule.Remove.AzureADGroup',
  'PrivilegedEligibilitySchedule.Remove.AzureADGroup',
  'AgentIdentity.Create.All',
  'AgentIdentity.CreateAsManager',
  'AgentIdentity.DeleteRestore.All',
  'AgentIdentity.EnableDisable.All',
  'AgentIdentity.ReadWrite.All',
  'AgentIdentityBlueprint.Create',
  'AgentIdentityBlueprint.DeleteRestore.All',
  'AgentIdentityBlueprint.UpdateBranding.All',
  'AgentIdentityBlueprintPrincipal.Create',
  'AgentIdentityBlueprintPrincipal.DeleteRestore.All',
  'AgentIdentityBlueprintPrincipal.EnableDisable.All',
  'AgentIdentityBlueprintPrincipal.ReadWrite.All',
  'AgentInstance.ReadWrite.All',
  'AgentInstance.ReadWrite.ManagedBy',
];
const writes = { allowAutomationWrites: true };
const named = { ...writes, identities: [{ name: 'ops', allowWrites: true }] };

describe('borderline application permissions (decided 2026-10-22)', () => {
  it('are tier 0 for app-only identities', () => {
    expect(DECIDED.filter((v) => !isPrivilegedAppRole(v))).toEqual([]);
    for (const v of DECIDED) {
      expect(ceilingFor(writes, 'automation', 'graph', v), v).toBe('appPrivileged');
      expect(ceilingFor(named, 'identity:ops', 'graph', v), v).toBe('identityPrivileged');
    }
  });

  it('leave delegated scopes alone', () => {
    for (const v of [
      'IdentityRiskyUser.ReadWrite.All',
      'Device.ReadWrite.All',
      'UserAuthenticationMethod.ReadWrite.All',
    ]) {
      expect(isPrivilegedDelegatedScope(v), v).toBe(false);
      expect(ceilingFor({}, 'write', 'graph', v), v).toBeUndefined();
    }
  });
});
