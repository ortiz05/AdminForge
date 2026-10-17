import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// security.overview 2.0: users at risk (Entra ID Protection) and Defender for Cloud posture — the Defender portal tiles
// are gone with that content (retired). An empty answer must never read as a critical 0 %.

const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const dashboard = definitions.find((d) => d.def.id === 'security.overview')!.def as Def;
const NOW = '2026-10-17T12:00:00Z';
const transform = (ds: string, value: unknown) =>
  renderString(dashboard.datasources[ds].transform, {
    now: NOW,
    user: {},
    env: {},
    params: {},
    value,
  }) as Promise<Def>;
const kpi = (id: string) => dashboard.layout.find((b: Def) => b.id === id);

describe('security.overview', () => {
  it('reads only risky users and Defender for Cloud', () => {
    expect(Object.keys(dashboard.datasources).sort()).toEqual(['mdc', 'risky']);
    expect(dashboard.requires.scopes.graph).toEqual(['IdentityRiskyUser.Read.All']);
  });

  it('Defender for Cloud: no subscriptions (or no access) leaves the score empty and neutral, not a red 0 %', async () => {
    const out = await transform('mdc', { value: [] });
    expect(out).toMatchObject({ rows: [], overall: null });
    expect(await renderString(kpi('mdc_overall').status, { value: out.overall })).toBe('neutral');
  });

  it('Defender for Cloud: the overall score weighs subscriptions by their maximum', async () => {
    const out = await transform('mdc', {
      value: [
        { subscriptionId: 'a', subscriptionName: 'Prod', current: 30, max: 60, percentage: 0.5 },
        { subscriptionId: 'b', subscriptionName: 'Dev', current: 36, max: 40, percentage: 0.9 },
      ],
    });
    expect(out.overall).toBe(0.66);
    expect(await renderString(kpi('mdc_overall').status, { value: out.overall })).toBe('warn');
  });

  it('users at risk: counts at-risk users, leaves out deleted ones, lists high and medium first', async () => {
    const out = await transform('risky', {
      value: [
        { id: '1', riskState: 'atRisk', riskLevel: 'high', riskLastUpdatedDateTime: '2026-10-17T10:00:00Z' },
        { id: '2', riskState: 'atRisk', riskLevel: 'low', riskLastUpdatedDateTime: '2026-10-17T11:00:00Z' },
        {
          id: '3',
          riskState: 'atRisk',
          riskLevel: 'medium',
          riskLastUpdatedDateTime: '2026-10-17T09:00:00Z',
        },
        { id: '4', riskState: 'atRisk', riskLevel: 'high', isDeleted: true },
      ],
    });
    expect(out).toMatchObject({ high: 1, atRisk: 3 });
    expect(out.top.map((u: Def) => u.id)).toEqual(['1', '3']);
  });
});
