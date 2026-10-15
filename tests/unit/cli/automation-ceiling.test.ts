import { randomUUID } from 'node:crypto';
import { AUTOMATION_GRAPH_ROLES, RESOURCES } from '@adminforge/cli/src/provision/catalog';
import { buildDesiredEntra, isReadOnlyAppRole } from '@adminforge/cli/src/provision/entra-desired';
import type { ProvisionSettings, ResourceServicePrincipal } from '@adminforge/cli/src/provision/model';

// Content may add read-only application permissions to the automation identity; permissions that change data need
// AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true, so a merged schedule can't quietly grant tenant-wide write access.
const settings: ProvisionSettings = {
  label: 'test',
  baseUrl: 'http://localhost:5173',
  tenantId: randomUUID(),
};
const roles = [...AUTOMATION_GRAPH_ROLES, 'SecurityIncident.Read.All', 'User.ReadWrite.All', 'Mail.Send'];
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
const content = { automation: { graph: ['SecurityIncident.Read.All', 'User.ReadWrite.All', 'Mail.Send'] } };
const automationRoles = (s: ProvisionSettings) =>
  buildDesiredEntra(s, { graph }, content)
    .apps.find((a) => a.key === 'automation')!
    .appPermissions.flatMap((p) => p.roles.map((r) => r.value));

describe('automation identity permission ceiling', () => {
  it('classifies application permissions', () => {
    for (const r of ['User.Read.All', 'RoleManagement.Read.Directory', 'SecurityIncident.Read.All'])
      expect(isReadOnlyAppRole(r)).toBe(true);
    for (const r of [
      'User.ReadWrite.All',
      'Mail.Send',
      'User.EnableDisableAccount.All',
      'Sites.FullControl.All',
    ])
      expect(isReadOnlyAppRole(r)).toBe(false);
  });

  it('grants content-declared read permissions but skips write ones, with a reason', () => {
    const granted = automationRoles(settings);
    expect(granted).toContain('SecurityIncident.Read.All');
    expect(granted).not.toContain('User.ReadWrite.All');
    expect(granted).not.toContain('Mail.Send');
    const skipped = buildDesiredEntra(settings, { graph }, content).skipped.map((s) => s.title);
    expect(skipped).toEqual(
      expect.arrayContaining([
        'automation → Microsoft Graph: User.ReadWrite.All',
        'automation → Microsoft Graph: Mail.Send',
      ]),
    );
  });

  it('grants them with the explicit opt-in', () => {
    expect(automationRoles({ ...settings, allowAutomationWrites: true })).toEqual(
      expect.arrayContaining(['User.ReadWrite.All', 'Mail.Send']),
    );
  });
});
