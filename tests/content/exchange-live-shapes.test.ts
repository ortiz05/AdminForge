import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Exchange Online content against the response shapes the live tenant returned (2026-10-16): an empty forwarding audit
// (findings: [] — the script used to emit null), a distribution list's members (a dependent datasource must read
// ds.group), automatic replies that are off but still carry Exchange's last period, and the inbox-rule audit's row
// actions (hidden rules — Exchange's own junk e-mail rule — can't be changed).

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const scope = (params: Record<string, unknown>, value: unknown) => ({
  params,
  user: { oid: 'x', upn: 'tester@example.com' },
  env: {},
  now: '2026-10-16T18:00:00Z',
  value,
});

describe('forwarding audit with nothing to report', () => {
  const empty = (findings: unknown) => [
    {
      acceptedDomains: ['example.com'],
      summary: { mailboxForwarding: 0, inboxRuleForwarding: 0, external: 0, mailboxesScannedForRules: 0 },
      findings,
    },
  ];

  it.each([[[]], [null]])('m365.mail-forwarding renders an empty list for findings %j', async (findings) => {
    const ds = def('m365.mail-forwarding').datasources.forwarding;
    const out = (await renderString(
      ds.transform,
      scope({ q: '', scope: 'All', source: 'All' }, empty(findings)),
    )) as Def;
    expect(out.rows).toEqual([]);
    expect(out.summary.external).toBe(0);
    expect(out.byDomain).toEqual([]);
  });

  it.each([[[]], [null]])('m365.external-forwarding counts nothing for findings %j', async (findings) => {
    const ds = def('m365.external-forwarding').datasources.forwarding;
    const out = (await renderString(ds.transform, scope({}, empty(findings)))) as Def;
    expect(out).toMatchObject({ rows: [], external: 0, mailboxes: 0, viaRules: 0, domains: 0 });
  });
});

describe('m365.distribution-list', () => {
  it('loads members once the directory object is known (ds.group)', () => {
    const members = def('m365.distribution-list').datasources.members;
    expect(members.when).toContain('ds.group.id');
    expect(members.request.path).toContain('ds.group.id');
  });
});

describe('m365.mailbox automatic replies', () => {
  const run = async (autoReply: Record<string, unknown>) => {
    const ds = def('m365.mailbox').datasources.mailbox;
    return (await renderString(
      ds.transform,
      scope({ mailbox: 'sales@example.com' }, [
        {
          primarySmtpAddress: 'sales@example.com',
          recipientTypeDetails: 'SharedMailbox',
          forwarding: { enabled: false, targets: [] },
          autoReply,
        },
      ]),
    )) as Def;
  };

  it('shows the period only when replies are scheduled', async () => {
    const period = { startTime: '2026-10-16T17:00:00.0000000Z', endTime: '2026-10-17T17:00:00.0000000Z' };
    expect((await run({ state: 'Disabled', externalAudience: 'All', ...period })).autoReply).toEqual({
      state: 'Disabled',
      externalAudience: 'All',
      startTime: null,
      endTime: null,
    });
    expect((await run({ state: 'Scheduled', externalAudience: 'All', ...period })).autoReply).toMatchObject(
      period,
    );
  });
});

describe('m365.inbox-rules row actions', () => {
  const actions = () =>
    def('m365.inbox-rules')
      .layout.find((b: Def) => b.widget === 'table')
      .rowActions.filter((a: Def) => a.playbook === 'm365.set-inbox-rule');
  const visible = async (row: Record<string, unknown>) => {
    const shown: string[] = [];
    for (const a of actions())
      if ((await renderString(a.when, { row })) === true) shown.push(a.inputs.action);
    return shown;
  };

  it('offers turning off, on and removing by rule id, never for hidden rules', async () => {
    const rule = {
      mailbox: 'adele@example.com',
      ruleIdentity: '17542359837015228417',
      ruleName: 'Send to home',
    };
    expect(await visible({ ...rule, enabled: true, hidden: false })).toEqual(['Disable', 'Remove']);
    expect(await visible({ ...rule, enabled: false, hidden: false })).toEqual(['Enable', 'Remove']);
    expect(await visible({ ...rule, enabled: true, hidden: true })).toEqual([]);
    expect(await visible({ ...rule, ruleIdentity: null, enabled: true })).toEqual([]);
  });
});
