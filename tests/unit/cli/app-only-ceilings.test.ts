import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AUTOMATION_GRAPH_ROLES, RESOURCES, type ResourceKey } from '@adminforge/cli/src/provision/catalog';
import { buildDesiredEntra, ceilingFor } from '@adminforge/cli/src/provision/entra-desired';
import type { ProvisionSettings, ResourceServicePrincipal } from '@adminforge/cli/src/provision/model';
import {
  isPrivilegedAppRole,
  isPrivilegedDelegatedScope,
  isSensitiveReadAppRole,
} from '@adminforge/cli/src/provision/privilege';

// App-only identities (the automation identity and named schedule identities) have ceilings of their own: tier-0
// application permissions need AF_AUTOMATION_ALLOW_PRIVILEGED_PERMISSIONS, sensitive reads
// AF_AUTOMATION_ALLOW_SENSITIVE_READS — the write opt-in alone grants neither. Names that change tenant trust, and
// reads of secrets or of every site, were let through by the write opt-in before (SECURITY.md › Identities).
const writes = { allowAutomationWrites: true };
const named = { ...writes, identities: [{ name: 'ops', allowWrites: true }] };

const TENANT_TRUST = [
  'Organization.ReadWrite.All',
  'Policy.ReadWrite.SecurityDefaults',
  'Policy.ReadWrite.ApplicationConfiguration',
  'Directory.Write.Restricted',
  'User-PasswordProfile.ReadWrite.All',
  'OnPremDirectorySynchronization.ReadWrite.All',
  'Synchronization.ReadWrite.All',
  'Application.ReadWrite.OwnedBy',
  'UserAuthenticationMethod.ReadWrite.All',
  'Group.ReadWrite.All',
  'GroupMember.ReadWrite.All',
];

describe('tier-0 application permissions', () => {
  it('withholds tenant-trust permissions from app-only identities that only have the write opt-in', () => {
    for (const v of TENANT_TRUST) {
      expect(ceilingFor(writes, 'automation', 'graph', v), v).toBe('appPrivileged');
      expect(ceilingFor(named, 'identity:ops', 'graph', v), v).toBe('identityPrivileged');
      // With the tier-0 opt-in only the other ceilings apply (UserAuthenticationMethod.ReadWrite.All also reads).
      expect(ceilingFor({ ...writes, allowAppPrivileged: true }, 'automation', 'graph', v), v).not.toBe(
        'appPrivileged',
      );
    }
  });

  it('catches Microsoft’s narrower names for the same power', () => {
    for (const v of [
      // One authentication method at a time (a Temporary Access Pass for an administrator), or deleting them.
      'UserAuthMethod-TAP.ReadWrite.All',
      'UserAuthMethod-Passkey.ReadWrite.All',
      'UserAuthMethod-Password.ReadWrite.All',
      'UserAuthMethod-Phone.Delete.All',
      'UserAuthenticationMethod.Delete.All',
      // Sign-in trust: one domain's federation, certificate authorities, mutual TLS, B2C and SPIFFE keys.
      'Domain-InternalFederation.ReadWrite.All',
      'PublicKeyInfrastructure.ReadWrite.All',
      'MutualTlsOauthConfiguration.ReadWrite.All',
      'TrustFrameworkKeySet.ReadWrite.All',
      'SpiffeTrustDomain.ReadWrite.All',
      'AuthenticationContext.ReadWrite.All',
      // Credentials of any app or agent blueprint.
      'Application.ReadUpdate.All',
      'AgentIdentityBlueprint.AddRemoveCreds.All',
      'AgentIdentityBlueprint.ReadWrite.All',
      'AgentIdentityBlueprint.UpdateAuthProperties.All',
      // Intune runs code as SYSTEM on every managed device, assigns Intune roles and wipes devices.
      'DeviceManagementConfiguration.ReadWrite.All',
      'DeviceManagementScripts.ReadWrite.All',
      'DeviceManagementApps.ReadWrite.All',
      'DeviceManagementRBAC.ReadWrite.All',
      'DeviceManagementManagedDevices.PrivilegedOperations.All',
      // Lifecycle workflows add group members and issue passes; partner admin relationships; Teams consent.
      'LifecycleWorkflows.ReadWrite.All',
      'LifecycleWorkflows-Workflow.ReadWrite.All',
      'LifecycleWorkflows-Workflow.Activate',
      'DelegatedAdminRelationship.ReadWrite.All',
      'TeamsAppInstallation.ReadWriteAndConsentForTeam.All',
      'TeamsAppInstallation.ReadWriteAndConsentSelfForChat.All',
    ])
      expect(ceilingFor(writes, 'automation', 'graph', v), v).toBe('appPrivileged');
    // Reads in the same families are not tier 0.
    for (const v of [
      'UserAuthMethod-TAP.Read.All',
      'LifecycleWorkflows-Workflow.ReadBasic.All',
      'Domain.Read.All',
    ])
      expect(isPrivilegedAppRole(v), v).toBe(false);
  });

  it('covers whole role-management, PIM and policy write families, not only the listed names', () => {
    for (const v of [
      'Policy.ReadWrite.FeatureRollout',
      'Policy.ReadWrite.TrustFramework',
      'PrivilegedAccess.ReadWrite.AzureResources',
      'RoleManagementPolicy.ReadWrite.AzureADGroup',
      'RoleManagement.ReadWrite.Exchange',
    ])
      expect(isPrivilegedAppRole(v), v).toBe(true);
    for (const v of ['User.ReadWrite.All', 'Device.ReadWrite.All', 'Policy.Read.All', 'Group.Read.All'])
      expect(isPrivilegedAppRole(v), v).toBe(false);
  });

  it('leaves the delegated list and the Write app as they were', () => {
    for (const v of [
      'Organization.ReadWrite.All',
      'Group.ReadWrite.All',
      'UserAuthenticationMethod.ReadWrite.All',
    ]) {
      expect(isPrivilegedDelegatedScope(v), v).toBe(false);
      expect(ceilingFor({}, 'write', 'graph', v), v).toBeUndefined();
    }
  });

  it('plans them as skipped with the tier-0 reason instead of granting them', () => {
    const roles = [
      ...AUTOMATION_GRAPH_ROLES,
      'Organization.ReadWrite.All',
      'Policy.ReadWrite.SecurityDefaults',
    ];
    const graph: ResourceServicePrincipal = {
      id: randomUUID(),
      appId: RESOURCES.graph.appId,
      oauth2PermissionScopes: [],
      appRoles: roles.map((value) => ({
        id: randomUUID(),
        value,
        allowedMemberTypes: ['Application'],
        isEnabled: true,
      })),
    };
    const settings: ProvisionSettings = {
      label: 'test',
      baseUrl: 'http://localhost:5173',
      tenantId: randomUUID(),
      allowAutomationWrites: true,
    };
    const d = buildDesiredEntra(
      settings,
      { graph },
      {
        automation: { graph: ['Organization.ReadWrite.All', 'Policy.ReadWrite.SecurityDefaults'] },
      },
    );
    const granted = d.apps
      .find((a) => a.key === 'automation')!
      .appPermissions.flatMap((p) => p.roles.map((r) => r.value));
    expect(granted).not.toContain('Organization.ReadWrite.All');
    expect(granted).not.toContain('Policy.ReadWrite.SecurityDefaults');
    const skipped = d.skipped
      .filter((s) => /tier-0 application permission/.test(s.reason))
      .map((s) => s.title);
    expect(skipped).toEqual(
      expect.arrayContaining([
        'automation → Microsoft Graph: Organization.ReadWrite.All',
        'automation → Microsoft Graph: Policy.ReadWrite.SecurityDefaults',
      ]),
    );
  });
});

describe('sensitive application reads', () => {
  it('withholds recovery secrets and personal records that a plain read permission reaches', () => {
    for (const v of [
      'DeviceLocalCredential.Read.All',
      'CallRecords.Read.All',
      'CallRecord-PstnCalls.Read.All',
      'ShortNotes.Read.All',
      'OnlineMeetingAiInsight.Read.All',
    ])
      expect(ceilingFor({}, 'automation', 'graph', v), v).toBe('automationSensitive');
    // The ReadBasic siblings return metadata only.
    for (const v of ['DeviceLocalCredential.ReadBasic.All', 'BitlockerKey.ReadBasic.All'])
      expect(ceilingFor({}, 'automation', 'graph', v), v).toBeUndefined();
  });

  it('withholds content that newer or narrower names reach, with or without the write opt-in', () => {
    // Read-only names: withheld with no opt-in at all.
    for (const v of [
      'CallRecordings.Read.All',
      'CallTranscripts.Read.All',
      'CallAiInsights.Read.All',
      'AiEnterpriseInteraction.Read.All',
      'RealTimeActivityFeed.Read.All',
      'UserAuthMethod-Phone.Read.All',
      'Group-Conversation.Read.All',
      'EngagementConversation.Read.All',
      'EngagementExport.Read.All',
      'PrintJob.Read.All',
    ])
      expect(ceilingFor({}, 'automation', 'graph', v), v).toBe('automationSensitive');
    // Names that also change data: the write opt-in alone doesn't grant them.
    for (const v of [
      'Mail-Advanced.ReadWrite.All',
      'MailboxItem.Export.All',
      'MailboxItem.ImportExport.All',
      'MailboxSettings.ReadWrite',
      'TeamMember.ReadWrite.All',
      'TeamMember.ReadWriteNonOwnerRole.All',
      'ChannelMember.ReadWrite.All',
      'ChatMember.ReadWrite.All',
      'Calls.JoinGroupCall.All',
      'User.Export.All',
    ])
      expect(ceilingFor(writes, 'automation', 'graph', v), v).toBe('automationSensitive');
    for (const v of ['PrintJob.ReadBasic.All', 'TeamMember.Read.All', 'MailboxSettings.Read'])
      expect(ceilingFor({}, 'automation', 'graph', v), v).toBeUndefined();
  });

  it('treats full control of every site or mailbox as a sensitive read on top of the write opt-in', () => {
    const cases: [ResourceKey, string][] = [
      ['graph', 'Sites.FullControl.All'],
      ['graph', 'Sites.Manage.All'],
      ['sharepoint', 'Sites.FullControl.All'],
      ['exchange', 'full_access_as_app'],
    ];
    for (const [resource, v] of cases) {
      expect(ceilingFor({}, 'automation', resource, v), v).toBe('automationWrite');
      expect(ceilingFor(writes, 'automation', resource, v), v).toBe('automationSensitive');
      expect(ceilingFor(named, 'identity:ops', resource, v), v).toBe('identitySensitive');
      expect(
        ceilingFor({ ...writes, allowAutomationSensitiveReads: true }, 'automation', resource, v),
        v,
      ).toBeUndefined();
    }
  });

  it('keeps per-site grants, meeting objects and app-only Exchange under the write ceiling only', () => {
    expect(ceilingFor({}, 'automation', 'graph', 'Sites.Selected')).toBeUndefined();
    expect(ceilingFor(writes, 'automation', 'graph', 'OnlineMeetings.ReadWrite.All')).toBeUndefined();
    // Exchange.ManageAsApp reaches nothing until an Exchange role is assigned to the app (provisioning assigns none).
    expect(ceilingFor({}, 'automation', 'exchange', 'Exchange.ManageAsApp')).toBe('automationWrite');
    expect(ceilingFor(writes, 'automation', 'exchange', 'Exchange.ManageAsApp')).toBeUndefined();
  });
});

describe('provisioning and the identity reports agree', () => {
  // The application-permission report ranks these names critical ("can take over the tenant or every mailbox/site").
  // Provisioning must not grant any of them to an app-only identity on the write opt-in alone.
  const report = readFileSync(
    new URL('../../../portal/content/reports/identity/app-permissions.report.yaml', import.meta.url),
    'utf8',
  );
  const critical = [...(/\$critical := \[([^\]]*)\]/.exec(report)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1]!,
  );
  // Accepted: bounded by the Exchange role assigned to the app, which provisioning never assigns (SECURITY.md).
  const WRITE_CEILING_ONLY = new Set(['Exchange.ManageAsApp']);
  const resourceOf = (v: string): ResourceKey =>
    /^(Exchange\.|full_access_as_app$)/.test(v) ? 'exchange' : 'graph';

  it('reads the report’s critical list', () => {
    expect(critical.length).toBeGreaterThan(20);
    expect(critical).toContain('Organization.ReadWrite.All');
  });

  it('withholds every critical name beyond the write opt-in', () => {
    const granted = critical.filter(
      (v) => !WRITE_CEILING_ONLY.has(v) && ceilingFor(writes, 'automation', resourceOf(v), v) === undefined,
    );
    expect(granted).toEqual([]);
  });

  it('keeps every tier-0 and sensitive name out of the automation baseline', () => {
    expect(AUTOMATION_GRAPH_ROLES.filter(isPrivilegedAppRole)).toEqual([]);
    expect(AUTOMATION_GRAPH_ROLES.filter(isSensitiveReadAppRole)).toEqual([]);
  });
});
