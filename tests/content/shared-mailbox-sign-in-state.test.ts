import path from 'node:path';
import { DatasourceRunner, fixtureRunner } from '@adminforge/api/src/datasources/executor';
import { FsDefinitionSource, registryFrom } from '@adminforge/api/src/definitions';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { createFixtureFetch } from '@adminforge/connectors';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Whether a shared mailbox's account can sign in comes from Microsoft Entra ID (accountEnabled, read with getByIds),
// not from Exchange's AccountDisabled — a copy that lagged more than 20 minutes behind Entra live. The Shared mailboxes
// page and the Shared mailboxes with sign-in allowed report merge the two: Entra wins, and a mailbox whose account
// Entra didn't return (or couldn't be read) keeps Exchange's state and says so.
//
// The fixtures disagree on purpose: Finance Invoices is enabled in Entra while Exchange still says disabled, Customer
// Support the other way round, and Entra doesn't return Events Booking's account (Exchange has no state for it).

const NOW = '2026-10-17T12:00:00Z';
const CONTENT = path.join(repoRoot, 'portal/content');
const FIXTURES = path.join(repoRoot, 'tests/fixtures');
const USER = { oid: 'automation', upn: 'automation', name: 'Automation identity', roles: ['Portal.Reader'] };
const PAGE = 'm365.shared-mailboxes';
const REPORT = 'm365.shared-mailbox-sign-in';

const loaded = await loadContentDir(CONTENT);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};

const registry = registryFrom(new FsDefinitionSource(CONTENT), 'fs');
const now = () => new Date(NOW);
const graphCalls: string[] = [];
const runner = new DatasourceRunner({
  definitions: registry,
  outbound: createOutboundExecutor({
    config: {
      DATA_MODE: 'fixtures',
      AF_SPO_TENANT_NAME: undefined,
      OUTBOUND_CONCURRENCY: 4,
      OUTBOUND_USER_CONCURRENCY: 4,
      OUTBOUND_TIMEOUT_MS: 30_000,
      TOKEN_CACHE_KEY: undefined,
    } as never,
    broker: null,
    auth: null,
    automation: null,
    fetch: createFixtureFetch(FIXTURES, { onRequest: (r) => graphCalls.push(`${r.method} ${r.url}`) }),
    env: () => ({}),
    now,
  }),
  runner: fixtureRunner(FIXTURES),
  env: () => ({}),
  now,
});
afterAll(() => registry.close());

async function run(id: string, datasource: string, params: Record<string, unknown> = {}): Promise<Def> {
  const page = await runner.page(id, def(id).version);
  const values = await runner.prepareParams(page, params, USER);
  const out = await runner.run({
    identity: { kind: 'automation', mode: 'read' },
    user: USER,
    page,
    datasource,
    params: values,
    correlationId: 'content-test',
    noCache: true,
  });
  return out.data;
}
const pick = (rows: Def[], ...fields: string[]) => rows.map((r) => fields.map((f) => r[f]));
const render = (str: string, scope: Record<string, unknown>) =>
  renderString(str, { now: NOW, user: USER, env: {}, params: {}, ...scope }) as Promise<Def>;

const guid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mailbox = (n: number, over: Record<string, unknown> = {}) => ({
  displayName: `Shared ${String(n).padStart(5, '0')}`,
  primarySmtpAddress: `shared${String(n).padStart(5, '0')}@example.com`,
  recipientTypeDetails: 'SharedMailbox',
  litigationHoldEnabled: false,
  archiveStatus: 'None',
  externalDirectoryObjectId: guid(n),
  accountDisabled: true,
  ...over,
});
const lookup = (accounts: Array<{ id: string; accountEnabled: boolean | null }>) =>
  Object.fromEntries(accounts.map((a) => [a.id, { accountEnabled: a.accountEnabled, signInFrom: 'entra' }]));

describe('Shared mailboxes page: sign-in state from Microsoft Entra ID', () => {
  it('takes Entra over Exchange both ways, and keeps Exchange only where Entra has no account', async () => {
    const out = await run(PAGE, 'shared', { q: '', licence: 'Any' });
    expect(pick(out.rows, 'primarySmtpAddress', 'signIn', 'signInFrom', 'accountDisabled')).toEqual([
      ['support@example.com', 'blocked', 'entra', false],
      ['events@example.com', 'unknown', 'exchange', null],
      ['invoices@example.com', 'allowed', 'entra', true],
      ['hr-confidential@example.com', 'blocked', 'entra', true],
      ['reception@example.com', 'allowed', 'entra', false],
    ]);
    expect(out).toMatchObject({
      total: 5,
      signInAllowed: 2,
      fromExchange: 1,
      needsLicence: 2,
      hidden: 1,
      truncated: false,
    });
  });

  it('asks Graph for the accounts once (one getByIds for up to 1,000), never per mailbox', async () => {
    graphCalls.length = 0;
    await run(PAGE, 'shared', { q: '', licence: 'Any' });
    const lookups = graphCalls.filter((c) => c.includes('/directoryObjects/getByIds'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatch(/^POST .*\$select=id%2CaccountEnabled/);
  });

  it('still searches and filters by licence', async () => {
    const support = await run(PAGE, 'shared', { q: 'SUPPORT', licence: 'Any' });
    expect(pick(support.rows, 'primarySmtpAddress')).toEqual([['support@example.com']]);
    const needed = await run(PAGE, 'shared', { q: '', licence: 'needed' });
    expect(pick(needed.rows, 'primarySmtpAddress', 'needsLicence')).toEqual([
      ['invoices@example.com', true],
      ['hr-confidential@example.com', true],
    ]);
    const notNeeded = await run(PAGE, 'shared', { q: '', licence: 'notNeeded' });
    expect(notNeeded.rows).toHaveLength(3);
    // The KPIs count every shared mailbox, not the filtered list.
    expect(needed).toMatchObject({ signInAllowed: 2, needsLicence: 2 });
  });

  it('offers Block sign-in only where sign-in is allowed and the account is known', async () => {
    const table = def(PAGE).layout.find((b: Def) => b.widget === 'table');
    const action = table.rowActions.find((a: Def) => a.playbook === 'identity.disable-user');
    const when = (row: Record<string, unknown>) => renderString(action.when, { row });
    expect(await when({ signIn: 'allowed', externalDirectoryObjectId: guid(1) })).toBe(true);
    expect(await when({ signIn: 'blocked', externalDirectoryObjectId: guid(1) })).toBe(false);
    expect(await when({ signIn: 'unknown', externalDirectoryObjectId: guid(1) })).toBe(false);
    expect(await when({ signIn: 'allowed', externalDirectoryObjectId: null })).toBe(false);
    // Exchange said disabled, Entra says enabled: the row says allowed, so the action is there.
    const out = await run(PAGE, 'shared', { q: 'invoices', licence: 'Any' });
    expect(await when(out.rows[0])).toBe(true);
  });

  it("falls back to Exchange's state for every mailbox when Graph couldn't be read (optional lookups)", async () => {
    const summary = {
      total: 3,
      hiddenFromAddressLists: 0,
      mailboxes: [
        mailbox(1, { accountDisabled: false }),
        mailbox(2, { accountDisabled: true }),
        mailbox(3, { accountDisabled: null }),
      ],
    };
    const out = await render(def(PAGE).datasources.shared.transform, {
      params: { q: '', licence: 'Any' },
      ds: { summary, accounts1: null, accounts2: null, accounts3: null, accounts4: null, accounts5: null },
    });
    expect(pick(out.rows, 'signIn', 'signInFrom')).toEqual([
      ['allowed', 'exchange'],
      ['blocked', 'exchange'],
      ['unknown', 'exchange'],
    ]);
    expect(out).toMatchObject({ signInAllowed: 1, fromExchange: 3 });
  });

  it('handles a single mailbox and a single account (no list to unwrap)', async () => {
    const out = await render(def(PAGE).datasources.shared.transform, {
      params: { q: '', licence: 'Any' },
      ds: {
        summary: { total: 1, hiddenFromAddressLists: 0, mailboxes: mailbox(7, { accountDisabled: true }) },
        accounts1: lookup([{ id: guid(7), accountEnabled: true }]),
      },
    });
    expect(Array.isArray(out.rows)).toBe(true);
    expect(pick(out.rows, 'signIn', 'signInFrom')).toEqual([['allowed', 'entra']]);
  });

  it('an account Entra returns without a state is Unknown, not dropped', async () => {
    const out = await render(def(PAGE).datasources.shared.transform, {
      params: { q: '', licence: 'Any' },
      ds: {
        summary: { total: 1, hiddenFromAddressLists: 0, mailboxes: [mailbox(8, { accountDisabled: false })] },
        accounts1: lookup([{ id: guid(8), accountEnabled: null }]),
      },
    });
    expect(pick(out.rows, 'signIn', 'signInFrom')).toEqual([['unknown', 'entra']]);
  });
});

describe('Shared mailboxes with sign-in allowed report', () => {
  it('lists allowed (Entra first-hand) then unknown, with the object id Block sign-in needs', async () => {
    const out = await run(REPORT, 'mailboxes');
    expect(pick(out.rows, 'primarySmtpAddress', 'signIn', 'signInFrom', 'canBlock')).toEqual([
      ['invoices@example.com', 'allowed', 'entra', true],
      ['reception@example.com', 'allowed', 'entra', true],
      ['events@example.com', 'unknown', 'exchange', false],
    ]);
    expect(out).toMatchObject({
      allowed: 2,
      unknown: 1,
      blocked: 2,
      fromExchange: 1,
      total: 5,
      truncated: false,
    });
    const all = await run(REPORT, 'mailboxes', { includeBlocked: true });
    expect(pick(all.rows, 'primarySmtpAddress', 'signIn').slice(3)).toEqual([
      ['support@example.com', 'blocked'],
      ['hr-confidential@example.com', 'blocked'],
    ]);
  });

  it('an allowed mailbox without an Entra object id is listed but cannot be blocked from here', async () => {
    const out = await render(def(REPORT).datasources.mailboxes.transform, {
      params: { includeBlocked: false },
      ds: {
        summary: {
          total: 1,
          mailboxes: [mailbox(9, { accountDisabled: false, externalDirectoryObjectId: null })],
        },
      },
    });
    expect(pick(out.rows, 'signIn', 'signInFrom', 'canBlock')).toEqual([['allowed', 'exchange', false]]);
  });
});

describe('getByIds in chunks of 1,000', () => {
  // 2,500 mailboxes (some without an account) in no particular order: three lookups run, the other chunks are skipped,
  // and together the lookups ask for every account exactly once.
  const mailboxes = Array.from({ length: 2500 }, (_, i) => {
    const n = (i * 7919) % 2500;
    return mailbox(n, n % 500 === 0 ? { externalDirectoryObjectId: null } : {});
  });
  const withAccount = mailboxes
    .filter((m) => m.externalDirectoryObjectId)
    .map((m) => m.externalDirectoryObjectId);

  for (const [id, chunks] of [
    [PAGE, 5],
    [REPORT, 10],
  ] as const) {
    it(`${id}: ${chunks} lookups, each its own slice; together every account once`, async () => {
      const ds = def(id).datasources;
      const asked: string[] = [];
      const runs: boolean[] = [];
      for (let k = 1; k <= chunks; k++) {
        const lookup = ds[`accounts${k}`];
        expect(lookup).toMatchObject({
          source: 'graph',
          optional: true,
          request: {
            method: 'POST',
            path: '/directoryObjects/getByIds',
            query: { $select: 'id,accountEnabled' },
          },
        });
        expect(lookup.when).toContain(`[[${(k - 1) * 1000}..${k * 1000 - 1}]]`);
        const scope = { ds: { summary: { mailboxes } } };
        const runsNow = await render(lookup.when, scope);
        runs.push(runsNow);
        if (!runsNow) continue;
        const ids = await render(lookup.request.body.ids, scope);
        expect(ids.length).toBeLessThanOrEqual(1000);
        asked.push(...ids);
      }
      expect(ds[`accounts${chunks + 1}`]).toBeUndefined();
      expect(runs).toEqual(Array.from({ length: chunks }, (_, i) => i < 3));
      expect(asked).toHaveLength(withAccount.length);
      expect(new Set(asked)).toEqual(new Set(withAccount));
    });
  }

  it('the page reads as many accounts as mailboxes (5,000), the report likewise (10,000)', () => {
    expect(def(PAGE).datasources.summary.parameters.resultSize).toBe(5000);
    expect(def(REPORT).datasources.summary.parameters.resultSize).toBe(10000);
  });
});
