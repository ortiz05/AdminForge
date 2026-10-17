import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Entra ID and Intune content against what the live tenant did (Phase 2 validation, 2026-10-16):
// - GET /auditLogs/signIns/{id} took ~165 s and then failed, so the sign-in page filters the list on the id, bounded to
//   five minutes around the sign-in's time (`at`, passed by every list that opens it) — ~2 s;
// - Graph v1.0 has no mobileApp.isAssigned (beta only): the apps page reads assignments instead;
// - GET /identityProtection/riskyUsers/{id} is a 404 without a readable message for a user who was never at risk, so
//   the risky-user playbooks and runbooks filter the list on the id (an empty list) instead.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};
const scope = (params: Record<string, unknown>, value?: unknown, inputs?: Record<string, unknown>) => ({
  params,
  inputs: inputs ?? {},
  user: { oid: 'x', upn: 'tester@example.com' },
  env: {},
  now: '2026-10-16T18:00:00Z',
  value,
});

const ID = '00000000-0000-4000-8000-0000000f0002';
const OTHER = '00000000-0000-4000-8000-0000000f0001';

describe('identity.sign-in looks the sign-in up through a bounded filter', () => {
  const ds = def('identity.sign-in').datasources.signIn;

  it('reads the sign-ins list, never the slow GET by id', () => {
    expect(ds.request.path).toBe('/auditLogs/signIns');
    expect(ds.request.query.$top).toBe(1);
  });

  it('bounds the filter to five minutes around `at`', async () => {
    const filter = await renderString(
      ds.request.query.$filter,
      scope({ id: ID, at: '2026-10-16T12:00:00Z' }),
    );
    expect(filter).toBe(
      `id eq '${ID}' and createdDateTime ge 2026-10-16T11:55:00.000Z and createdDateTime le 2026-10-16T12:05:00.000Z`,
    );
  });

  it('without `at` (an old link) searches the last 7 days, not 30 (a missing id timed out over 30 days)', async () => {
    expect(await renderString(ds.request.query.$filter, scope({ id: ID }))).toBe(
      `id eq '${ID}' and createdDateTime ge 2026-10-09T18:00:00.000Z`,
    );
  });

  it('keeps an empty answer for minutes, not an hour (sign-ins arrive late)', () => {
    expect(ds.cache.ttl).toBeLessThanOrEqual(300);
  });

  it('shows the row with the requested id, whatever else the answer holds (fixtures answer with the whole list)', async () => {
    const value = {
      value: [
        { id: OTHER, status: { errorCode: 50126 }, location: {}, appliedConditionalAccessPolicies: [] },
        {
          id: ID,
          status: { errorCode: 0 },
          location: { city: 'Leeds', countryOrRegion: 'GB', geoCoordinates: {} },
          appliedConditionalAccessPolicies: [
            {
              id: 'p1',
              displayName: 'Require MFA',
              result: 'reportOnlySuccess',
              enforcedGrantControls: ['Mfa'],
            },
          ],
        },
      ],
    };
    const out = (await renderString(ds.transform, scope({ id: ID.toUpperCase() }, value))) as Def;
    expect(out).toMatchObject({ id: ID, result: 'success', place: 'Leeds, GB' });
    expect(out.policies).toHaveLength(1);
  });

  it('is empty when the sign-in is not in the answer', async () => {
    const out = await renderString(ds.transform, scope({ id: ID }, { value: [] }));
    expect(out).toBeUndefined();
  });

  describe("a sign-in that isn't in the log", () => {
    const page = def('identity.sign-in');
    const render = (t: string, signIn: unknown) =>
      renderString(t, { params: { id: ID }, signIn, now: '2026-10-16T18:00:00Z' });

    it('says so in the header instead of " → " and "Failure"', async () => {
      expect(await render(page.header.title, undefined)).toBe('Sign-in not found');
      expect(await render(page.header.status, undefined)).toBe('neutral');
      expect(await render(page.header.statusLabel, undefined)).toBe('Not found');
      expect(
        await render(page.header.title, {
          id: ID,
          userDisplayName: 'Avery',
          appDisplayName: 'Teams',
          result: 'success',
        }),
      ).toBe('Avery → Teams');
    });

    it("explains why, and offers no actions on a user it doesn't know", async () => {
      const note = page.tabs[0].layout.find((b: Def) => b.id === 'notFound');
      expect(await render(note.when, undefined)).toBe(true);
      expect(await render(note.when, { id: ID })).toBe(false);
      for (const a of page.actions) expect(await render(a.when, undefined)).toBe(false);
    });
  });

  it.each(['identity.sign-ins', 'identity.user', 'identity.enterprise-app'])(
    '%s passes the time when it opens a sign-in',
    (id) => {
      const text = JSON.stringify(def(id));
      expect(text).toMatch(
        /"page":"identity.sign-in","params":\{"id":"\$\{ row.id \}","at":"\$\{ row.createdDateTime \}"\}/,
      );
    },
  );
});

describe('endpoint.apps', () => {
  const ds = def('endpoint.apps').datasources.apps;

  it('asks v1.0 only for properties it has (no isAssigned) and expands assignments', () => {
    expect(ds.request.query.$select).not.toContain('isAssigned');
    expect(ds.request.query.$expand).toBe('assignments($select=id)');
  });

  it('marks an app assigned when it has assignments', async () => {
    const value = {
      value: [
        {
          '@odata.type': '#microsoft.graph.win32LobApp',
          id: 'a',
          displayName: 'App A',
          assignments: [{ id: 'x' }],
        },
        { '@odata.type': '#microsoft.graph.win32LobApp', id: 'b', displayName: 'App B', assignments: [] },
      ],
    };
    const out = (await renderString(
      ds.transform,
      scope({ q: '', platform: 'Any', kind: 'Any', assigned: 'Any' }, value),
    )) as Def;
    expect(out.rows.map((r: Def) => [r.id, r.assigned])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(out.unassigned).toBe(1);
  });
});

describe('risky-user lookups filter the list instead of reading the user directly', () => {
  const steps = (id: string): Def[] => {
    const d = def(id);
    return d.steps ?? d.sections.flatMap((s: Def) => s.steps ?? []);
  };

  it.each([
    ['security.dismiss-risky-user', 'lookup'],
    ['security.confirm-risky-user-compromised', 'riskLookup'],
    ['security.compromised-account-response', 'riskLookup'],
    ['identity.compromised-account', 'riskLookup'],
  ])('%s', async (id, lookupId) => {
    const all = steps(id);
    const lookup = all.find((s) => s.id === lookupId);
    expect(lookup.request.path).toBe('/identityProtection/riskyUsers');
    expect(await renderString(lookup.request.query.$filter, scope({}, undefined, { userId: ID }))).toBe(
      `id eq '${ID}'`,
    );
    const risk = all.find((s) => s.id === 'risk');
    expect(risk).toMatchObject({ type: 'transform' });
    expect(JSON.stringify(all)).not.toContain('riskyUsers/${');

    // Only this user's row counts: an answer (a fixture, or Graph ignoring the filter) holding another user's risk.
    const answer = (value: unknown[]) => ({
      inputs: { userId: ID },
      steps: { [lookupId]: { output: { value } } },
    });
    const mine = { id: ID.toUpperCase(), riskState: 'atRisk' };
    const theirs = { id: OTHER, riskState: 'confirmedCompromised' };
    expect(await renderString(risk.expression, answer([theirs]))).toBeUndefined();
    expect(await renderString(risk.expression, answer([theirs, mine]))).toEqual(mine);
  });
});
