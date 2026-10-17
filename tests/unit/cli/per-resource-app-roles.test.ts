import { randomUUID } from 'node:crypto';
import { AUTOMATION_GRAPH_ROLES, RESOURCES } from '@adminforge/cli/src/provision/catalog';
import {
  buildDesiredEntra,
  ceilingFor,
  isPerResourceAppRole,
} from '@adminforge/cli/src/provision/entra-desired';
import type { ProvisionSettings, ResourceServicePrincipal } from '@adminforge/cli/src/provision/model';
import { isSensitiveReadAppRole } from '@adminforge/cli/src/provision/privilege';

// Sites.Selected (and its list/file siblings) reach nothing until an administrator grants one site, list or file to
// the app: provisioning may add it without AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS; tenant-wide writes still need it.
const settings: ProvisionSettings = {
  label: 'test',
  baseUrl: 'http://localhost:5173',
  tenantId: randomUUID(),
};
const extra = ['Sites.Selected', 'Sites.ReadWrite.All', 'OnlineMeetings.ReadWrite.All'];
const graph: ResourceServicePrincipal = {
  id: randomUUID(),
  appId: RESOURCES.graph.appId,
  oauth2PermissionScopes: [],
  appRoles: [...AUTOMATION_GRAPH_ROLES, ...extra].map((value) => ({
    id: randomUUID(),
    value,
    allowedMemberTypes: ['Application'],
    isEnabled: true,
  })),
};
const content = { automation: { graph: extra } };
const automationRoles = (s: ProvisionSettings) =>
  buildDesiredEntra(s, { graph }, content)
    .apps.find((a) => a.key === 'automation')!
    .appPermissions.flatMap((p) => p.roles.map((r) => r.value));

describe('per-resource application permissions', () => {
  it('recognises the Selected permissions only', () => {
    for (const r of [
      'Sites.Selected',
      'Lists.SelectedOperations.Selected',
      'ListItems.SelectedOperations.Selected',
      'Files.SelectedOperations.Selected',
    ])
      expect(isPerResourceAppRole(r)).toBe(true);
    for (const r of [
      'Sites.ReadWrite.All',
      'Sites.FullControl.All',
      'Files.ReadWrite.All',
      'Sites.Manage.All',
    ])
      expect(isPerResourceAppRole(r)).toBe(false);
  });

  it('grants Sites.Selected without the write opt-in, but not tenant-wide writes', () => {
    const granted = automationRoles(settings);
    expect(granted).toContain('Sites.Selected');
    expect(granted).not.toContain('Sites.ReadWrite.All');
    expect(granted).not.toContain('OnlineMeetings.ReadWrite.All');
    expect(ceilingFor(settings, 'automation', 'graph', 'OnlineMeetings.ReadWrite.All')).toBe(
      'automationWrite',
    );
    expect(ceilingFor(settings, 'automation', 'graph', 'Sites.Selected')).toBeUndefined();
  });

  it('keeps the write (and sensitive-read) opt-ins for the rest', () => {
    const writes = automationRoles({ ...settings, allowAutomationWrites: true });
    expect(writes).toEqual(expect.arrayContaining(['Sites.Selected', 'OnlineMeetings.ReadWrite.All']));
    // Tenant-wide site access also reads every file: it needs the sensitive-read opt-in on top.
    expect(writes).not.toContain('Sites.ReadWrite.All');
    expect(
      automationRoles({ ...settings, allowAutomationWrites: true, allowAutomationSensitiveReads: true }),
    ).toContain('Sites.ReadWrite.All');
  });

  it('treats everyone’s Teams presence as a sensitive read', () => {
    expect(isSensitiveReadAppRole('Presence.Read.All')).toBe(true);
    expect(ceilingFor(settings, 'automation', 'graph', 'Presence.Read.All')).toBe('automationSensitive');
  });
});
