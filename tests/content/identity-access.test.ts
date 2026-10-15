import path from 'node:path';
import { compileAdvanced, parseAdvanced } from '@adminforge/api/src/datasources/advanced';
import { renderTemplate } from '@adminforge/expressions';
import { advancedOpsFor, loadContentDir, type AdvancedField, type FilterBar } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Directory roles, enterprise-app access, groups and the identity list pages' query builders (identity access work).

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const byId = <T>(id: string): T => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def as unknown as T;
};

interface ListPage {
  params: Record<string, { default?: unknown }>;
  filters: FilterBar;
  datasources: Record<string, { request: { query: Record<string, unknown> } }>;
}

const now = new Date('2026-10-15T08:00:00Z');
/** A valid value for each field type, so every declared field is compiled once. */
const sample = (f: AdvancedField): unknown =>
  ({
    string: "O'Brien",
    number: 50126,
    boolean: true,
    date: '-30d',
    guid: '00000000-0000-4000-8000-000000000102',
    enum: f.values?.[0],
  })[f.type];

describe.each([
  ['identity.groups', 'groups'],
  ['identity.enterprise-apps', 'apps'],
  ['identity.app-registrations', 'apps'],
  ['identity.sign-ins', 'signIns'],
  ['identity.audit-logs', 'audits'],
])('%s query builder', (id, ds) => {
  const page = byId<ListPage>(id);
  const adv = page.filters.advanced!;
  const query = page.datasources[ds]!.request.query;
  const defaults = Object.fromEntries(
    Object.entries(page.params).map(([k, p]) => [k, p.default ?? (k === 'range' ? {} : undefined)]),
  );

  it('is compiled server-side to OData', () => expect(adv.dialect).toBe('odata'));

  it.each(adv.fields.map((f) => [f.field, f] as const))('compiles %s into a quoted OData clause', (_n, f) => {
    const op = advancedOpsFor(f)[0]!;
    const value = op === 'in' ? [sample(f)] : sample(f);
    const group = parseAdvanced(adv, { all: [{ field: f.field, op, value }] }, now)!;
    const odata = compileAdvanced(group, 'odata');
    expect(odata).toContain(f.property ?? f.field);
    if (f.type === 'string') expect(odata).toContain("'O''Brien'");
  });

  it('appends the compiled filter to the facet filters and leaves them alone without one', async () => {
    const without = await renderTemplate<Record<string, unknown>>(query, { params: defaults });
    const clause = "displayName eq 'x'";
    const withAdv = await renderTemplate<Record<string, unknown>>(query, {
      params: defaults,
      advanced: clause,
    });
    const before = without.$filter as string | undefined;
    expect(withAdv.$filter).toBe(before ? `${before} and ${clause}` : clause);
  });
});

describe('identity.create-group', () => {
  interface Step {
    id: string;
    request: { body: string };
    expression: string;
  }
  const pb = byId<{ steps: Step[] }>('identity.create-group');
  const step = (id: string) => pb.steps.find((s) => s.id === id)!;
  const body = async (inputs: Record<string, unknown>) => {
    const names = await renderTemplate(step('names').expression, { inputs });
    return renderTemplate<Record<string, unknown>>(step('create').request.body, {
      inputs,
      steps: { names: { output: names } },
    });
  };
  const base = { displayName: ' Sales Team ', description: 'Everyone in sales', visibility: 'Private' };

  it('creates a mail-disabled security group with assigned membership', async () =>
    expect(await body({ ...base, groupType: 'Security', membership: 'Assigned', ownerIds: [] })).toEqual({
      displayName: 'Sales Team',
      description: 'Everyone in sales',
      mailNickname: 'SalesTeam',
      mailEnabled: false,
      securityEnabled: true,
      groupTypes: [],
    }));

  it('creates a dynamic Microsoft 365 group with its rule, privacy and owners', async () =>
    expect(
      await body({
        ...base,
        groupType: 'Microsoft365',
        membership: 'Dynamic',
        membershipRule: ' (user.department -eq "Sales") ',
        ownerIds: ['00000000-0000-4000-8000-000000000101'],
      }),
    ).toEqual({
      displayName: 'Sales Team',
      description: 'Everyone in sales',
      mailNickname: 'SalesTeam',
      mailEnabled: true,
      securityEnabled: false,
      groupTypes: ['Unified', 'DynamicMembership'],
      visibility: 'Private',
      membershipRule: '(user.department -eq "Sales")',
      membershipRuleProcessingState: 'On',
      'owners@odata.bind': ['https://graph.microsoft.com/v1.0/users/00000000-0000-4000-8000-000000000101'],
    }));

  it('replaces the retired identity.create-security-group everywhere', () => {
    expect(byId<{ status?: string }>('identity.create-security-group').status).toBe('retired');
    const ref = /"(playbook|ref)":"identity\.create-security-group"/;
    const refs = loaded.definitions.filter((d) => ref.test(JSON.stringify(d.def)));
    expect(refs.map((d) => d.file)).toEqual([]);
  });
});

describe('identity.privileged-role-assignments', () => {
  interface Report {
    datasources: { assignments: { transform: string } };
    layout: Array<{ widget: string; feature?: string }>;
  }
  const report = byId<Report>('identity.privileged-role-assignments');
  const principal = {
    '@odata.type': '#microsoft.graph.user',
    displayName: 'Adele Lee',
    userPrincipalName: 'a.lee@example.com',
  };
  const value = (eligible: unknown) => ({
    definitions: {
      value: [
        {
          id: '62e90394-69f5-4237-9190-012177145e10',
          displayName: 'Global Administrator',
          isPrivileged: true,
        },
      ],
    },
    active: {
      value: [
        {
          id: 'ra-1',
          principalId: 'p1',
          roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10',
          directoryScopeId: '/',
          principal,
        },
      ],
    },
    eligible,
    instances: { error: { code: 'AadPremiumLicenseRequired' } },
  });

  it('gates the eligible (PIM) part on Entra ID P2', () =>
    expect(report.layout.filter((w) => w.widget === 'licenceGate').map((w) => w.feature)).toEqual(['pim']));

  it('still lists standing assignments when the PIM sub-requests fail', async () => {
    const out = await renderTemplate<{ rows: Array<{ assignment: string }>; pimAvailable: boolean }>(
      report.datasources.assignments.transform,
      {
        value: value({ error: { code: 'AadPremiumLicenseRequired' } }),
        params: { scope: 'Privileged', assignment: 'Any', principal: 'Any' },
      },
    );
    expect(out.pimAvailable).toBe(false);
    expect(out.rows.map((r) => r.assignment)).toEqual(['Standing']);
  });
});

describe('role and user pages feed the role playbooks', () => {
  it('identity.role eligible rows carry the raw directory scope for Remove eligibility', async () => {
    const role = byId<{ datasources: { pim: { transform: string } } }>('identity.role');
    const out = await renderTemplate<{ eligible: Array<{ scopeId: string; scope: string }> }>(
      role.datasources.pim.transform,
      {
        value: {
          eligible: {
            value: [
              {
                id: 'e1',
                principalId: 'p1',
                directoryScopeId: '/administrativeUnits/au-1',
                memberType: 'Direct',
                principal: {},
              },
            ],
          },
          activated: { value: [] },
        },
      },
    );
    expect(out.eligible[0]).toMatchObject({
      scopeId: '/administrativeUnits/au-1',
      scope: '/administrativeUnits/au-1',
    });
  });

  it('identity.user role rows carry the assignment id and raw scope', async () => {
    const page = byId<{ datasources: { roles: { transform: string } } }>('identity.user');
    const out = await renderTemplate<{ rows: Array<Record<string, unknown>> }>(
      page.datasources.roles.transform,
      {
        value: {
          active: {
            value: [
              {
                id: 'ra-5',
                roleDefinitionId: 'r1',
                directoryScopeId: '/',
                roleDefinition: { displayName: 'User Administrator' },
              },
            ],
          },
          eligible: {
            value: [
              {
                id: 're-3',
                roleDefinitionId: 'r2',
                directoryScopeId: '/',
                memberType: 'Direct',
                roleDefinition: { displayName: 'Security Reader' },
              },
            ],
          },
          activated: { value: [] },
        },
      },
    );
    expect(out.rows).toEqual([
      expect.objectContaining({ assignmentId: 'ra-5', assignment: 'Active', scopeId: '/' }),
      expect.objectContaining({ assignment: 'Eligible', scopeId: '/', memberType: 'Direct' }),
    ]);
  });
});
