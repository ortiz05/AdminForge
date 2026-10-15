import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixtureRunner } from '@adminforge/api/src/datasources/executor';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString, renderTemplate, type RowsFilterGroup } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Mailbox access and settings (m365.mailbox, m365.mailboxes advanced filter), the inbox-rule audit, Teams user policies,
// Defender device vulnerabilities, and the actions wired into the forwarding and team pages. Datasources run the way
// DATA_MODE=fixtures runs them: parameters rendered, the fixture variant picked, then the transform.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const fixtures = path.join(repoRoot, 'tests/fixtures');
const runner = fixtureRunner(fixtures);
const fetchFixture = createFixtureFetch(fixtures);
const NOW = '2026-10-15T12:00:00Z';
const scopeOf = (params: Record<string, unknown>, advanced?: RowsFilterGroup) => ({
  params,
  user: { oid: 'x', upn: 'tester@example.com' },
  env: {},
  now: NOW,
  ...(advanced ? { advanced } : {}),
});

async function runRunner(
  pageId: string,
  name: string,
  params: Record<string, unknown>,
  advanced?: RowsFilterGroup,
) {
  const ds = def(pageId).datasources[name];
  const scope = scopeOf(params, advanced);
  if (ds.when && (await renderString(ds.when, scope)) !== true) return null;
  const parameters = (await renderTemplate<Record<string, unknown>>(ds.parameters ?? {}, scope)) ?? {};
  const { data } = await runner.run(
    { kind: 'automation', mode: 'read' } as never,
    {
      script: ds.script,
      sha256: ds.sha256,
      parameters,
      services: ds.services,
      timeoutSeconds: 300,
      mode: 'read',
    },
    { correlationId: 'content-test' },
  );
  return renderString(ds.transform, { ...scope, value: data }) as Promise<Def>;
}

async function runHunting(name: string, params: Record<string, unknown>) {
  const ds = def('security.device-vulnerabilities').datasources[name];
  const scope = scopeOf({ q: '', severity: 'Any', platform: 'Any', ...params });
  const body = await renderTemplate<{ Query: string }>(ds.request.body, scope);
  const res = await fetchFixture('https://graph.microsoft.com/v1.0/security/runHuntingQuery', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return {
    query: body!.Query,
    out: (await renderString(ds.transform, { ...scope, value: await res.json() })) as Def,
  };
}

describe('runner scripts are pinned', () => {
  it('every new datasource and step points at the current sha256 of its script', () => {
    const refs: Array<{ id: string; script: string; sha256: string }> = [];
    const walk = (id: string, v: unknown): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(id, x));
      else if (v && typeof v === 'object') {
        const o = v as { script?: unknown; sha256?: unknown };
        if (typeof o.script === 'string' && typeof o.sha256 === 'string')
          refs.push({ id, script: o.script, sha256: o.sha256 });
        Object.values(v).forEach((x) => walk(id, x));
      }
    };
    for (const id of [
      'm365.mailbox',
      'm365.inbox-rules',
      'm365.teams-user-policies',
      'm365.grant-mailbox-permission',
      'm365.remove-mailbox-permission',
      'm365.clear-mailbox-forwarding',
      'm365.set-mailbox-auto-reply',
      'm365.set-address-list-visibility',
      'm365.grant-onedrive-access',
    ])
      walk(id, def(id));
    expect(refs.length).toBeGreaterThan(12);
    for (const r of refs) {
      const text = readFileSync(path.join(repoRoot, 'portal/content/scripts', r.script));
      expect([r.id, r.script, createHash('sha256').update(text).digest('hex')]).toEqual([
        r.id,
        r.script,
        r.sha256,
      ]);
    }
  });
});

describe('m365.mailbox', () => {
  it('shows settings and access for the mailbox that was asked for', async () => {
    const mailbox = await runRunner('m365.mailbox', 'mailbox', { mailbox: 'dana@example.com' });
    expect(mailbox).toMatchObject({
      primarySmtpAddress: 'dana@example.com',
      typeLabel: 'User mailbox',
      forwardsTo: 'dana.former@outlook.example',
      forwarding: { enabled: true, external: true },
    });
    const access = await runRunner('m365.mailbox', 'permissions', { mailbox: 'invoices@example.com' });
    expect(access.summary).toMatchObject({ fullAccess: 3, sendAs: 1, sendOnBehalf: 1, orphaned: 1 });
    expect(access.rows.every((r: Def) => r.mailbox === 'invoices@example.com')).toBe(true);
    const orphan = access.rows.find((r: Def) => r.orphaned);
    expect([orphan.name, orphan.removable]).toEqual([orphan.trustee, false]);
    expect(access.rows.filter((r: Def) => r.removable).map((r: Def) => r.key)).toEqual([
      'fullaccess|nora.fischer@example.com',
      'fullaccess|blake@example.com',
      'sendas|nora.fischer@example.com',
    ]);
  });

  it('offers removal only for direct grants and passes the row to the playbook', async () => {
    const table = def('m365.mailbox')
      .tabs.find((t: Def) => t.id === 'access')
      .layout.find((b: Def) => b.widget === 'table');
    const remove = table.rowActions[0];
    expect(remove.playbook).toBe('m365.remove-mailbox-permission');
    const row = {
      mailbox: 'support@example.com',
      trustee: 'avery@example.com',
      permission: 'SendAs',
      removable: true,
    };
    expect(await renderString(remove.when, { row })).toBe(true);
    expect(await renderString(remove.when, { row: { ...row, removable: false } })).toBe(false);
    expect(await renderTemplate(remove.inputs, { row })).toEqual({
      mailbox: 'support@example.com',
      trustee: 'avery@example.com',
      permission: 'SendAs',
    });
  });
});

describe('m365.mailboxes query builder (dialect: rows)', () => {
  const all = (...clauses: RowsFilterGroup['clauses']): RowsFilterGroup => ({ join: 'and', clauses });
  const base = { q: '', type: 'All', hold: 'Any', archive: 'Any', hidden: false };

  it('declares the builder on the runner datasource and keeps every row without a filter', async () => {
    expect(def('m365.mailboxes').filters.advanced.dialect).toBe('rows');
    const out = await runRunner('m365.mailboxes', 'mailboxes', base);
    expect(out.rows).toHaveLength(19);
  });

  it('filters by computed and native fields, combined with the facets', async () => {
    const shared = await runRunner(
      'm365.mailboxes',
      'mailboxes',
      base,
      all(
        { path: 'domain', type: 'string', op: 'eq', value: 'example.com' },
        { path: 'recipientTypeDetails', type: 'enum', op: 'in', value: ['SharedMailbox', 'RoomMailbox'] },
      ),
    );
    expect(shared.rows.map((r: Def) => r.primarySmtpAddress)).toEqual([
      'reception@example.com',
      'invoices@example.com',
      'support@example.com',
      'hr-confidential@example.com',
      'room-boardroom@example.com',
      'room-atlas@example.com',
    ]);
    const recentOnHoldOff = await runRunner(
      'm365.mailboxes',
      'mailboxes',
      { ...base, hold: 'Off', type: 'UserMailbox' },
      all({ path: 'whenCreated', type: 'date', op: 'ge', value: '2025-06-01T00:00:00.000Z' }),
    );
    expect(recentOnHoldOff.rows.map((r: Def) => r.displayName)).toEqual([
      'Avery Engineer',
      'Blake Analyst',
      "Eli O'Brien",
    ]);
    // KPIs stay organization-wide.
    expect(recentOnHoldOff.total).toBe(19);
  });
});

describe('m365.inbox-rules', () => {
  it('scans the organization and lists outside forwarding first', async () => {
    const out = await runRunner('m365.inbox-rules', 'rules', {
      mailbox: '',
      allRules: false,
      includeHidden: false,
      maxMailboxes: 500,
    });
    expect(out.scope).toBe('organization');
    expect(out.rows.map((r: Def) => r.risk)).toEqual(['high', 'high', 'high', 'medium', 'medium', 'medium']);
    expect(out.mailboxes).toBe(5);
    expect(out.byRisk[0]).toEqual({ risk: 'Outside forwarding', rules: 3 });
  });

  it('audits one mailbox, and every rule on request', async () => {
    const risky = await runRunner('m365.inbox-rules', 'rules', {
      mailbox: 'isaac.mensah@example.com',
      allRules: false,
    });
    expect([risky.scope, risky.rows.map((r: Def) => r.ruleName)]).toEqual(['mailbox', ['Backup']]);
    const every = await runRunner('m365.inbox-rules', 'rules', {
      mailbox: 'isaac.mensah@example.com',
      allRules: true,
    });
    expect(every.rows.map((r: Def) => `${r.ruleName}:${r.risk}`)).toEqual([
      'Backup:high',
      'Newsletters:none',
    ]);
  });
});

describe('m365.teams-user-policies', () => {
  it('waits for a sign-in name', async () => {
    expect(await runRunner('m365.teams-user-policies', 'policies', { user: '', area: 'All' })).toBeNull();
    expect(
      await runRunner('m365.teams-user-policies', 'policies', { user: 'blake', area: 'All' }),
    ).toBeNull();
  });

  it('shows where each policy comes from and filters by area', async () => {
    const all = await runRunner('m365.teams-user-policies', 'policies', {
      user: 'blake@example.com',
      area: 'All',
    });
    expect(all.user.displayName).toBe('Blake Analyst');
    expect(all.rows).toHaveLength(15);
    const core = await runRunner('m365.teams-user-policies', 'policies', {
      user: 'blake@example.com',
      area: 'Core',
    });
    expect(core.rows.map((r: Def) => `${r.label}:${r.policyName}:${r.assignment}`)).toEqual([
      'Messaging:Restricted chat:Group',
      'Meetings:Global:Default',
      'Calling:No calling:Group',
      'App setup:Global:Default',
    ]);
    const assigned = await runRunner('m365.teams-user-policies', 'policies', {
      user: ' gabriel.nunes@example.com ',
      area: 'Assigned',
    });
    expect(assigned.rows.map((r: Def) => r.policyType)).toEqual([
      'TeamsCallingPolicy',
      'OnlineVoiceRoutingPolicy',
      'TenantDialPlan',
    ]);
  });

  it('is linked from the team member and owner lists for members only', async () => {
    const team = def('m365.team');
    const tables = team.tabs
      .flatMap((t: Def) => t.layout)
      .filter((b: Def) => b.widget === 'table' && b.rowActions);
    const links = tables.flatMap((t: Def) => t.rowActions).filter((a: Def) => a.label === 'Teams policies');
    expect(links).toHaveLength(2);
    const row = { userPrincipalName: 'adele.vance@example.com', userType: 'Member' };
    expect(await renderString(links[0].href, { row })).toBe(
      '/p/m365.teams-user-policies?user=adele.vance%40example.com',
    );
    expect(await renderString(links[0].when, { row: { ...row, userType: 'Guest' } })).toBe(false);
    // Team settings and channels need Teams; the Microsoft 365 group itself doesn't.
    expect(team.requires.licences).toBeUndefined();
    expect([team.datasources.team.requires, team.datasources.channels.requires]).toEqual([
      { licences: ['teams'] },
      { licences: ['teams'] },
    ]);
  });
});

describe('security.device-vulnerabilities', () => {
  it('summarises, lists devices and CVEs from advanced hunting', async () => {
    const summary = await runHunting('summary', {});
    expect(summary.out.bySeverity).toEqual([
      { severity: 'Critical', cves: 3 },
      { severity: 'High', cves: 14 },
      { severity: 'Medium', cves: 61 },
      { severity: 'Low', cves: 69 },
    ]);
    const devices = await runHunting('devices', {});
    expect(devices.out.rows[0]).toMatchObject({ DeviceName: 'ex-lt-0193.example.com', exposure: 'Critical' });
    expect(devices.out.rows.at(-1).exposure).toBe('Medium');
    const cves = await runHunting('cves', {});
    expect(cves.out.exploitable).toBe(4);
  });

  it('filters in KQL with quoted values only', async () => {
    const critical = await runHunting('devices', { severity: 'Critical', platform: 'WindowsServer' });
    expect(critical.query).toContain('| where VulnerabilitySeverityLevel == "Critical"');
    expect(critical.query).toContain("| where OSPlatform startswith 'WindowsServer'");
    expect(critical.out.rows.every((r: Def) => r.Critical > 0)).toBe(true);
    const sneaky = await runHunting('cves', {
      q: 'x" | take 1 //',
      platform: 'Linux',
      severity: "High' or 1==1",
    });
    expect(sneaky.query).toContain(
      '| where DeviceName startswith "x\\" | take 1 //" or SoftwareName has "x\\" | take 1 //"',
    );
    expect(sneaky.query).toContain('| where OSPlatform =~ "Linux"');
    // A severity outside the list never reaches the query.
    expect(sneaky.query).not.toContain('or 1==1');
  });

  it('is gated on Defender Vulnerability Management (Defender for Endpoint P2 or the add-on)', () => {
    expect(def('security.device-vulnerabilities').requires).toMatchObject({
      scopes: { graph: ['ThreatHunting.Read.All'] },
      licences: ['WINDEFATP', 'TVM_PREMIUM_1'],
    });
  });
});

describe('Clear forwarding on the forwarding page and report', () => {
  it.each(['m365.mail-forwarding', 'm365.external-forwarding'])(
    '%s offers it for mailbox-level forwarding',
    async (id) => {
      const table = def(id).layout.find((b: Def) => b.widget === 'table');
      const action = table.rowActions.find((a: Def) => a.playbook === 'm365.clear-mailbox-forwarding');
      expect(await renderTemplate(action.inputs, { row: { mailbox: 'dana@example.com' } })).toEqual({
        mailbox: 'dana@example.com',
      });
      expect(await renderString(action.when, { row: { source: 'mailbox' } })).toBe(true);
      expect(await renderString(action.when, { row: { source: 'inboxRule' } })).toBe(false);
      expect(table.inspect.page).toBe('m365.mailbox');
    },
  );
});
