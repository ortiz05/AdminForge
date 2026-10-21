import { RESOURCE_GRAPH_UNION_MESSAGE, resourceGraphJoinProblem } from '@adminforge/schemas';
import { AVERY, FakeOutbound, schedulesApp } from './schedules-helpers';

/**
 * Query Studio refuses the Resource Graph queries Azure refuses — the same join/union lint `adminforge validate` runs
 * on content (`resourceGraphJoinProblem` and the leading-union rule in @adminforge/schemas) — before anything is sent
 * to Microsoft or audited, so "Save as report" can't fail later for a query that seemed to work.
 */
const FOUR_JOINS = [
  'resources',
  "| join kind=leftouter (resources | where type =~ 'a') on id",
  "| join kind=leftouter (resources | where type =~ 'b') on id",
  "| join kind=leftouter (resources | where type =~ 'c') on id",
  "| join kind=leftouter (resources | where type =~ 'd') on id",
].join('\n');
const TWO_CROSS_JOINS = [
  'resources',
  '| join kind=leftouter (resourcecontainers) on subscriptionId',
  '| join kind=leftouter (advisorresources) on id',
].join('\n');
const CROSS_UNION = 'resources | union (securityresources)';
const LEADING_UNION = 'union resources, resourcecontainers';

describe('Query Studio and Resource Graph join limits', () => {
  it.each([
    ['four joins', FOUR_JOINS, /at most three join or union operations/],
    ['a union with another table', CROSS_UNION, /only unions within one table/],
    ['two joins to other tables', TWO_CROSS_JOINS, /only one join to another table/],
    ['a leading union', LEADING_UNION, /can't start a query with union/],
  ])('refuses %s with the rule and what to change, before any call or audit', async (_, query, rule) => {
    const outbound = new FakeOutbound(() => ({ value: [{ n: 1 }], totalRecords: 1 }));
    const t = await schedulesApp({ outbound });
    const user = await t.login(AVERY, ['Portal.Reader']);
    const res = await user.post('/api/query', { source: 'resourceGraph', query });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('invalid_query');
    expect(error.message).toMatch(rule);
    expect(error.message).toMatch(/\.$/);
    expect(error.hint).toMatch(/^[A-Z]/);
    expect(error.hint).toMatch(/split|separate|own datasource|pipe one table/i);
    // The rule in the message, what to do in the hint: neither repeats the other.
    expect(error.message).not.toContain(error.hint);
    expect(error.correlationId).toEqual(expect.any(String));
    expect(outbound.calls).toHaveLength(0);
    expect(t.audit.rows.filter((r) => r.action === 'query.executed')).toHaveLength(0);
    await t.close();
  });

  it('words it exactly as validate does (one lint, not a copy)', async () => {
    const t = await schedulesApp({ outbound: new FakeOutbound(() => ({ value: [] })) });
    const user = await t.login(AVERY, ['Portal.Reader']);
    for (const [query, lint] of [
      [FOUR_JOINS, resourceGraphJoinProblem(FOUR_JOINS)!],
      [LEADING_UNION, RESOURCE_GRAPH_UNION_MESSAGE],
    ] as const) {
      const { error } = (await user.post('/api/query', { source: 'resourceGraph', query })).json();
      const plain = (s: string) => s.replace(/[.:]\s*$/, '').toLowerCase();
      expect(lint.toLowerCase()).toContain(plain(error.message));
      expect(lint.toLowerCase()).toContain(plain(error.hint));
    }
    await t.close();
  });

  it('runs queries within the limits, and leaves other sources alone', async () => {
    const outbound = new FakeOutbound((call) =>
      call.service === 'logAnalytics'
        ? { value: [], tables: [{ name: 'PrimaryResult', columns: [] }] }
        : { value: [{ n: 1 }], totalRecords: 1 },
    );
    const t = await schedulesApp({ outbound });
    const user = await t.login(AVERY, ['Portal.Reader']);
    const threeJoins = FOUR_JOINS.split('\n').slice(0, 4).join('\n');
    const subscriptionNames =
      'resources | join kind=leftouter (resourcecontainers | where type =~ "microsoft.resources/subscriptions") on subscriptionId';
    for (const query of [threeJoins, subscriptionNames, 'resources | union (resources | where false)'])
      expect((await user.post('/api/query', { source: 'resourceGraph', query })).statusCode).toBe(200);
    // Log Analytics has no such limits: the lint is Resource Graph's only.
    const workspace = '00000000-0000-4000-8000-00000000abcd';
    const la = await user.post('/api/query', { source: 'logAnalytics', query: FOUR_JOINS, workspace });
    expect(la.statusCode).toBe(200);
    expect(outbound.calls).toHaveLength(4);
    await t.close();
  });
});
