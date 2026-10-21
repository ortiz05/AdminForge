import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Shared mailboxes' sign-in state from Microsoft Entra ID at the caps the page (5,000 mailboxes) and the report
// (10,000) read, under the API's transform budget: each getByIds chunk's `when` and ids (a native sort and slice)
// and the merge of Graph's state into Exchange's rows. Run in the `scale` project (after the other projects, one file
// at a time) because the budget is wall-clock. Behaviour: shared-mailbox-sign-in-state.test.ts.

const NOW = '2026-10-17T12:00:00Z';
const USER = { oid: 'automation', upn: 'automation', name: 'Automation identity', roles: ['Portal.Reader'] };
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};

// The API's 250 ms budget plus 20 % for a test runner that shares the CPU with the other test files.
const SCALE_TIMEOUT_MS = 300;
const atScale = (str: string, scope: Record<string, unknown>) =>
  renderString(
    str,
    { now: NOW, user: USER, env: {}, params: {}, ...scope },
    { timeoutMs: SCALE_TIMEOUT_MS },
  ) as Promise<Def>;

const guid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** `n` shared mailboxes in no particular order; every third one Exchange still says is enabled. */
const summaryOf = (n: number) => ({
  total: n,
  truncated: false,
  hiddenFromAddressLists: 0,
  mailboxes: Array.from({ length: n }, (_, i) => {
    const k = (i * 7919) % n;
    return {
      displayName: `Shared ${String(k).padStart(5, '0')}`,
      userPrincipalName: `shared${k}@example.com`,
      primarySmtpAddress: `shared${k}@example.com`,
      recipientTypeDetails: 'SharedMailbox',
      whenCreated: '2025-01-01T00:00:00Z',
      hiddenFromAddressListsEnabled: false,
      litigationHoldEnabled: k % 50 === 0,
      archiveStatus: k % 40 === 0 ? 'Active' : 'None',
      externalDirectoryObjectId: guid(k),
      accountDisabled: k % 3 !== 0,
    };
  }),
});
/** What each chunk's getByIds transform returns: Entra says every tenth account is enabled. */
async function lookups(id: string, chunks: number, summary: Def) {
  const ds: Record<string, unknown> = { summary };
  for (let k = 1; k <= chunks; k++) {
    const spec = def(id).datasources[`accounts${k}`];
    const scope = { ds: { summary } };
    if (!(await atScale(spec.when, scope))) {
      ds[`accounts${k}`] = null;
      continue;
    }
    const ids: string[] = await atScale(spec.request.body.ids, scope);
    const value = ids.map((x) => ({
      '@odata.type': '#microsoft.graph.user',
      id: x,
      accountEnabled: Number(x.slice(-12)) % 10 === 0,
    }));
    ds[`accounts${k}`] = await atScale(spec.transform, { value: { value } });
  }
  return ds;
}

describe('scale', { retry: 2 }, () => {
  it('Shared mailboxes page: 5,000 mailboxes, five lookups of 1,000 accounts', async () => {
    const ds = await lookups('m365.shared-mailboxes', 5, summaryOf(5000));
    const out = await atScale(def('m365.shared-mailboxes').datasources.shared.transform, {
      ds,
      params: { q: '', licence: 'Any' },
    });
    expect(out.rows).toHaveLength(5000);
    expect(out).toMatchObject({ total: 5000, signInAllowed: 500, fromExchange: 0 });
    const filtered = await atScale(def('m365.shared-mailboxes').datasources.shared.transform, {
      ds,
      params: { q: 'shared1', licence: 'needed' },
    });
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.rows.every((r: Def) => r.needsLicence === true)).toBe(true);
  });

  it('Shared mailboxes with sign-in allowed report: 10,000 mailboxes, ten lookups', async () => {
    const ds = await lookups('m365.shared-mailbox-sign-in', 10, summaryOf(10000));
    const out = await atScale(def('m365.shared-mailbox-sign-in').datasources.mailboxes.transform, {
      ds,
      params: { includeBlocked: true },
    });
    expect(out.rows).toHaveLength(10000);
    expect(out).toMatchObject({ allowed: 1000, blocked: 9000, unknown: 0, fromExchange: 0 });
    expect(out.rows.slice(0, 1000).every((r: Def) => r.signIn === 'allowed' && r.canBlock === true)).toBe(
      true,
    );
  });
});
