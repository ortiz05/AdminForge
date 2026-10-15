import {
  compareScopes,
  emptyScopeSet,
  provisionedScopes,
  type Declared,
  type ScopeSet,
} from '@adminforge/cli/src/content/scopes';
import { AUTOMATION_BUILTIN_USES, AUTOMATION_GRAPH_ROLES } from '@adminforge/cli/src/provision/catalog';

// `validate --scopes` computes what provisioning expects with the same function as `provision entra`, so the two
// agree: read-only scopes copied from write content aren't "unused", ceiling-withheld and unlicensed permissions aren't
// "missing", and baseline permissions are labelled (with the built-in code that needs them).
function declared(spec: Partial<Record<keyof ScopeSet, Record<string, string[]>>>): Declared {
  const scopes = emptyScopeSet();
  const files = new Map<string, string[]>();
  for (const [app, services] of Object.entries(spec))
    for (const [service, list] of Object.entries(services ?? {}))
      for (const s of list) {
        ((scopes[app as keyof ScopeSet] as Record<string, Set<string>>)[service] ??= new Set()).add(s);
        files.set(`${app}:${service}:${s}`, [`${app}/${s}.yaml`]);
      }
  return { scopes, files, connections: [] };
}
const granted = (spec: Partial<Record<keyof ScopeSet, Record<string, string[]>>>) => declared(spec).scopes;

const content = declared({
  read: { graph: ['User.Read.All'] },
  write: {
    graph: ['Group.ReadWrite.All', 'MailboxSettings.Read', 'RoleManagement.ReadWrite.Directory'],
    exchange: ['Exchange.Manage'],
  },
  automation: { graph: ['Organization.Read.All', 'Mail.Read'] },
});

describe('validate --scopes agrees with provisioning', () => {
  const provisioned = provisionedScopes({}, content.scopes);
  const present = new Set(['graph', 'arm', 'logAnalytics'] as const);

  it('does not report the read-only scopes of write content on the Read app as unused', () => {
    const r = compareScopes(
      content,
      granted({ read: { graph: ['User.Read.All', 'MailboxSettings.Read'] } }),
      provisioned,
      present,
    );
    expect(r.unused).toEqual([]);
    // Without the provisioning view (old behaviour) it would have been.
    expect(compareScopes(content, granted({ read: { graph: ['MailboxSettings.Read'] } })).unused).toEqual([
      { app: 'read', service: 'graph', scope: 'MailboxSettings.Read' },
    ]);
  });

  it('reports ceiling-withheld scopes as withheld (with the env key) and unlicensed workloads as skipped, not missing', () => {
    const r = compareScopes(content, granted({}), provisioned, present);
    expect(r.withheld.map((w) => `${w.app} ${w.scope}`)).toEqual([
      'write RoleManagement.ReadWrite.Directory',
      'automation Mail.Read',
    ]);
    expect(r.withheld[0]!.reason).toMatch(/AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true/);
    expect(r.withheld[1]!.reason).toMatch(/AF_AUTOMATION_ALLOW_SENSITIVE_READS=true/);
    expect(r.unlicensed.map((u) => `${u.app} ${u.service} ${u.scope}`)).toEqual([
      'write exchange Exchange.Manage',
    ]);
    expect(r.missing.map((m) => `${m.app} ${m.scope}`)).toEqual([
      'read User.Read.All',
      'write Group.ReadWrite.All',
      'write MailboxSettings.Read',
      'automation Organization.Read.All',
    ]);
  });

  it('with the opt-in, a withheld scope becomes an ordinary missing one', () => {
    const r = compareScopes(
      content,
      granted({}),
      provisionedScopes({ allowPrivilegedWriteScopes: true }, content.scopes),
      present,
    );
    expect(r.missing.map((m) => m.scope)).toContain('RoleManagement.ReadWrite.Directory');
  });

  it('labels baseline permissions no content declares, naming built-in code that relies on them', () => {
    const r = compareScopes(
      content,
      granted({ automation: { graph: [...AUTOMATION_GRAPH_ROLES, 'Mail.Send'] } }),
      provisioned,
      present,
    );
    const builtin = r.baseline.filter((b) => b.builtin).map((b) => b.scope);
    expect(builtin.sort()).toEqual(
      Object.keys(AUTOMATION_BUILTIN_USES)
        .filter((s) => s !== 'Organization.Read.All') // declared by content above
        .filter((s) => s !== 'Mail.Send') // conditional (AF_MAIL_SENDER), not baseline
        .sort(),
    );
    expect(r.baseline.find((b) => b.scope === 'Device.Read.All')).toMatchObject({ builtin: undefined });
    // Granted but neither declared nor provisioned: genuinely unused.
    expect(r.unused).toEqual([{ app: 'automation', service: 'graph', scope: 'Mail.Send' }]);
  });
});
