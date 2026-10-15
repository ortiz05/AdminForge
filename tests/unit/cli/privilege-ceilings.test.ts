import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_GRAPH_ROLES,
  READ_GRAPH_SCOPES,
  RESOURCES,
  WRITE_GRAPH_SCOPES,
  type ResourceKey,
} from '@adminforge/cli/src/provision/catalog';
import { buildDesiredEntra, desiredPermissions } from '@adminforge/cli/src/provision/entra-desired';
import { diffApplication } from '@adminforge/cli/src/provision/entra-plan';
import type { ProvisionSettings, ResourceServicePrincipal } from '@adminforge/cli/src/provision/model';
import {
  isPrivilegedDelegatedScope,
  isSensitiveReadAppRole,
  isWriteCapableDelegatedScope,
  PRIVILEGED_DELEGATED_SCOPES,
} from '@adminforge/cli/src/provision/privilege';

// Provisioning ceilings: tier-0 delegated scopes (Read/Write apps) and sensitive reads (automation identity) are
// granted only with an explicit opt-in in the env file, whatever content declares.
const settings: ProvisionSettings = {
  label: 'test',
  baseUrl: 'http://localhost:5173',
  tenantId: randomUUID(),
};

const PRIVILEGED = [
  'Directory.AccessAsUser.All',
  'RoleManagement.ReadWrite.Directory',
  'AppRoleAssignment.ReadWrite.All',
  'DelegatedPermissionGrant.ReadWrite.All',
  'Application.ReadWrite.All',
  'RoleEligibilitySchedule.ReadWrite.Directory',
  'RoleAssignmentSchedule.ReadWrite.Directory',
];
const SENSITIVE = ['Mail.Read', 'Files.Read.All', 'Sites.Read.All', 'Chat.Read.All', 'BitlockerKey.Read.All'];

function resource(key: ResourceKey, scopes: string[], roles: string[] = []): ResourceServicePrincipal {
  return {
    id: randomUUID(),
    appId: RESOURCES[key].appId,
    oauth2PermissionScopes: scopes.map((value) => ({ id: randomUUID(), value, isEnabled: true })),
    appRoles: roles.map((value) => ({ id: randomUUID(), value, allowedMemberTypes: ['Application'] })),
  };
}

const resources = () => ({
  graph: resource(
    'graph',
    [...READ_GRAPH_SCOPES, ...WRITE_GRAPH_SCOPES, ...PRIVILEGED, 'Group.Create', 'MailboxSettings.Read'],
    [...AUTOMATION_GRAPH_ROLES, ...SENSITIVE, 'Mail.ReadWrite', 'ThreatHunting.Read.All'],
  ),
  arm: resource('arm', ['user_impersonation']),
  logAnalytics: resource('logAnalytics', ['Data.Read']),
  exchange: resource('exchange', ['Exchange.Manage']),
  sharepoint: resource('sharepoint', ['AllSites.FullControl']),
});

const content = {
  read: {
    graph: ['Sites.Read.All', 'Directory.AccessAsUser.All'],
    sharepointAdmin: ['AllSites.FullControl'],
  },
  write: { graph: [...PRIVILEGED, 'Group.Create', 'MailboxSettings.Read'] },
  automation: { graph: [...SENSITIVE, 'Mail.ReadWrite', 'ThreatHunting.Read.All'] },
};

const grantOf = (d: ReturnType<typeof buildDesiredEntra>, app: 'read' | 'write') =>
  d.apps.find((a) => a.key === app)!.grants.find((g) => g.resource === 'graph')!.scopes;
const rolesOf = (d: ReturnType<typeof buildDesiredEntra>) =>
  d.apps.find((a) => a.key === 'automation')!.appPermissions.flatMap((p) => p.roles.map((r) => r.value));

describe('permission classification', () => {
  it('knows the tier-0 delegated scopes, including any RoleManagement.ReadWrite.*', () => {
    for (const s of [...PRIVILEGED, 'Directory.ReadWrite.All', 'RoleManagement.ReadWrite.Exchange'])
      expect(isPrivilegedDelegatedScope(s)).toBe(true);
    for (const s of ['User.ReadWrite.All', 'Group.ReadWrite.All', 'User.EnableDisableAccount.All'])
      expect(isPrivilegedDelegatedScope(s)).toBe(false);
  });

  it('knows the sensitive reads (mail, files, sites, chats, keys …) but not ordinary directory reads', () => {
    for (const s of [
      ...SENSITIVE,
      'Mail.ReadBasic.All',
      'Calendars.Read',
      'Contacts.Read',
      'Notes.Read.All',
      'ChannelMessage.Read.All',
      'OnlineMeetingTranscript.Read.All',
      'OnlineMeetingRecording.Read.All',
      'UserAuthenticationMethod.Read.All',
    ])
      expect(isSensitiveReadAppRole(s)).toBe(true);
    for (const s of ['User.Read.All', 'Sites.Selected', 'BitlockerKey.ReadBasic.All', 'AuditLog.Read.All'])
      expect(isSensitiveReadAppRole(s)).toBe(false);
  });

  it('classifies write-capable delegated scopes (not sign-in scopes or reads)', () => {
    for (const s of ['Exchange.Manage', 'AllSites.FullControl', 'user_impersonation', 'Group.ReadWrite.All'])
      expect(isWriteCapableDelegatedScope(s)).toBe(true);
    for (const s of ['openid', 'offline_access', 'User.Read', 'Data.Read', 'Team.ReadBasic.All'])
      expect(isWriteCapableDelegatedScope(s)).toBe(false);
  });

  it('keeps every tier-0 scope and sensitive read out of the baselines', () => {
    expect([...READ_GRAPH_SCOPES, ...WRITE_GRAPH_SCOPES].filter(isPrivilegedDelegatedScope)).toEqual([]);
    expect(AUTOMATION_GRAPH_ROLES.filter(isSensitiveReadAppRole)).toEqual([]);
    expect(PRIVILEGED_DELEGATED_SCOPES.length).toBeGreaterThan(PRIVILEGED.length);
  });
});

describe('tier-0 delegated scopes (AF_ALLOW_PRIVILEGED_WRITE_SCOPES)', () => {
  it('withholds them from the Write and Read apps by default, with the env key in the reason', () => {
    const d = buildDesiredEntra(settings, resources(), content);
    expect(grantOf(d, 'write')).toContain('Group.Create');
    for (const s of PRIVILEGED) expect(grantOf(d, 'write')).not.toContain(s);
    expect(grantOf(d, 'read')).not.toContain('Directory.AccessAsUser.All');
    const skipped = d.skipped.filter((s) => /tier-0/.test(s.reason));
    expect(skipped.map((s) => s.title)).toEqual(
      expect.arrayContaining([
        'AdminForge Write [test] → Microsoft Graph: Directory.AccessAsUser.All',
        'AdminForge Read [test] → Microsoft Graph: Directory.AccessAsUser.All',
      ]),
    );
    expect(
      skipped.every(
        (s) => s.section === 'Consent grants' && /AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true/.test(s.reason),
      ),
    ).toBe(true);
  });

  it('grants them with the opt-in', () => {
    const d = buildDesiredEntra({ ...settings, allowPrivilegedWriteScopes: true }, resources(), content);
    expect(grantOf(d, 'write')).toEqual(expect.arrayContaining(PRIVILEGED));
    expect(d.skipped.filter((s) => /tier-0/.test(s.reason))).toEqual([]);
  });

  it('desiredPermissions reports what it withholds, per app and ceiling, without tenant lookups', () => {
    const { withheld } = desiredPermissions({}, content);
    expect(withheld.filter((w) => w.ceiling === 'privileged').map((w) => `${w.app}:${w.value}`)).toEqual(
      expect.arrayContaining(['write:Application.ReadWrite.All', 'read:Directory.AccessAsUser.All']),
    );
  });
});

describe('sensitive reads for the automation identity (AF_AUTOMATION_ALLOW_SENSITIVE_READS)', () => {
  it('withholds mail, files, sites, chats and BitLocker keys by default; ordinary reads still go through', () => {
    const d = buildDesiredEntra(settings, resources(), content);
    expect(rolesOf(d)).toContain('ThreatHunting.Read.All');
    for (const s of SENSITIVE) expect(rolesOf(d)).not.toContain(s);
    expect(d.skipped.map((s) => s.title)).toEqual(
      expect.arrayContaining(SENSITIVE.map((s) => `automation → Microsoft Graph: ${s}`)),
    );
    expect(d.skipped.find((s) => s.title.endsWith(': Mail.Read'))!.reason).toMatch(
      /AF_AUTOMATION_ALLOW_SENSITIVE_READS=true/,
    );
  });

  it('grants them with the opt-in; Mail.ReadWrite needs both the write and the sensitive-read opt-in', () => {
    const reads = rolesOf(
      buildDesiredEntra({ ...settings, allowAutomationSensitiveReads: true }, resources(), content),
    );
    expect(reads).toEqual(expect.arrayContaining(SENSITIVE));
    expect(reads).not.toContain('Mail.ReadWrite');
    const writesOnly = rolesOf(
      buildDesiredEntra({ ...settings, allowAutomationWrites: true }, resources(), content),
    );
    expect(writesOnly).not.toContain('Mail.ReadWrite');
    const both = buildDesiredEntra(
      { ...settings, allowAutomationWrites: true, allowAutomationSensitiveReads: true },
      resources(),
      content,
    );
    expect(rolesOf(both)).toContain('Mail.ReadWrite');
  });
});

describe('Read app: write-capable delegated scopes are surfaced', () => {
  it('lists Exchange.Manage (baseline) and content-declared AllSites.FullControl; ARM is inherent', () => {
    const d = buildDesiredEntra(settings, resources(), content);
    expect(d.readWriteCapable).toEqual(
      expect.arrayContaining([
        { resource: 'exchange', scope: 'Exchange.Manage', granted: true },
        { resource: 'sharepoint', scope: 'AllSites.FullControl', granted: true },
      ]),
    );
    expect(d.readWriteCapable.some((w) => w.resource === 'arm')).toBe(false);
    expect(d.readArmInherent).toBe(true);
    // Read-only scopes of write content (dry runs) are copied to the Read app; write scopes never are.
    expect(grantOf(d, 'read')).toContain('MailboxSettings.Read');
    expect(grantOf(d, 'read')).not.toContain('Group.Create');
  });

  it('marks them not granted when the workload is not in the tenant', () => {
    const r: Partial<ReturnType<typeof resources>> = resources();
    delete r.exchange;
    const d = buildDesiredEntra(settings, r, content);
    expect(d.readWriteCapable).toContainEqual({
      resource: 'exchange',
      scope: 'Exchange.Manage',
      granted: false,
    });
  });
});

describe('app registration hardening', () => {
  const d = buildDesiredEntra(settings, resources());
  const app = (k: string) => d.apps.find((a) => a.key === k)!;

  it('asks for the acct claim on the Read and Write ID tokens (guest accounts are refused by the API)', () => {
    expect(app('read').body.optionalClaims.idToken.map((c) => c.name)).toContain('acct');
    expect(app('write').body.optionalClaims.idToken.map((c) => c.name)).toEqual([
      'auth_time',
      'acrs',
      'acct',
    ]);
  });

  it('requires assignment on every service principal, including the automation identity', () => {
    expect(d.apps.map((a) => a.sp.appRoleAssignmentRequired)).toEqual([true, true, true]);
  });

  it('enforces confidential web clients only: no public-client flows, no public-client or SPA redirect URIs', () => {
    for (const a of d.apps) {
      expect(a.body.isFallbackPublicClient).toBe(false);
      expect(a.body.publicClient).toEqual({ redirectUris: [] });
      expect(a.body.spa).toEqual({ redirectUris: [] });
    }
    const body = app('read').body;
    const current = { id: 'i', appId: 'a', ...body };
    expect(diffApplication(body, current)).toEqual([]);
    expect(
      diffApplication(body, {
        ...current,
        isFallbackPublicClient: true,
        publicClient: { redirectUris: ['http://localhost'] },
        spa: { redirectUris: ['https://example.com/spa'] },
      }),
    ).toEqual(['isFallbackPublicClient', 'publicClient', 'spa']);
    // Graph returns null for an app that never set these: same as the desired state.
    expect(
      diffApplication(body, { ...current, isFallbackPublicClient: null, publicClient: null, spa: null }),
    ).toEqual([]);
  });
});

describe('provision entra: loud warning for write-capable scopes on the Read app', () => {
  it('names each scope with the content files that declare it, the baseline otherwise, and ARM once', async () => {
    const { readAppWriteWarnings } = await import('@adminforge/cli/src/commands/provision');
    const r: Partial<ReturnType<typeof resources>> = resources();
    delete r.sharepoint;
    const d = buildDesiredEntra(settings, r, content);
    const files = new Map([['read:sharepointAdmin:AllSites.FullControl', ['pages/m365/sharing.page.yaml']]]);
    const lines = readAppWriteWarnings({ desired: d, files });
    expect(lines[0]).toMatch(
      /^⚠ WRITE-CAPABLE delegated permissions on the READ app AdminForge Read \[test\]/,
    );
    expect(lines).toContain(
      '    Office 365 Exchange Online: Exchange.Manage — AdminForge baseline (portal/tools/cli/src/provision/catalog.ts)',
    );
    expect(lines).toContain(
      '    Office 365 SharePoint Online: AllSites.FullControl (not granted here: workload not licensed) — pages/m365/sharing.page.yaml',
    );
    expect(lines.filter((l) => /user_impersonation/.test(l))).toEqual([
      expect.stringMatching(/^ℹ Azure Service Management user_impersonation on the Read app is inherent/),
    ]);
  });
});
