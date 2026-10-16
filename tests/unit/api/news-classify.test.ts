import { classify } from '@adminforge/api/src/news/classify';
import type { Candidate } from '@adminforge/api/src/news/types';
import { Feed } from '@adminforge/schemas';

// Classification: areas/tags add up, kind/severity/status come from the first rule that sets them, exclude drops,
// keep: matched is the relevance filter for broad public feeds.
const item = (over: Partial<Candidate> = {}): Candidate => ({
  externalId: 'x',
  title: 'Retirement: classic alerts in Azure Monitor',
  summary: 'Move to log search alerts before March.',
  url: null,
  kind: 'info',
  severity: 'normal',
  status: null,
  publishedAt: new Date('2026-10-14T00:00:00Z'),
  updatedAt: null,
  actionRequiredBy: null,
  services: [],
  categories: ['Retirements', 'Azure Monitor'],
  tags: [],
  audience: [],
  facts: [],
  ...over,
});

const feed = (over: Record<string, unknown>) =>
  Feed.parse({
    kind: 'feed',
    id: 'feeds.test',
    version: '1.0.0',
    title: 'Test',
    owner: 'test',
    publisher: 'Microsoft',
    homepage: 'https://azure.microsoft.com/updates',
    collector: { kind: 'rss', url: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss' },
    ...over,
  });

describe('news classification', () => {
  const rules = feed({
    keep: 'matched',
    classify: [
      { match: { categories: ['Azure Virtual Desktop'] }, exclude: true },
      { match: { categories: ['retirements'] }, kind: 'retirement', status: 'Retiring' },
      {
        match: { categories: ['Azure Monitor'], text: ['Log Analytics'] },
        areas: ['azure'],
        tags: ['monitor'],
      },
      {
        match: { title: ['alerts'] },
        areas: ['security'],
        tags: ['alerts'],
        kind: 'change',
        severity: 'high',
      },
      { match: { services: ['Exchange Online'] }, areas: ['m365'], tags: ['exchange'] },
    ],
  });

  it('adds up areas and tags; the first rule that sets kind/severity/status wins', () => {
    expect(classify(rules, item())).toEqual({
      areas: ['azure', 'security'],
      tags: ['monitor', 'alerts'],
      kind: 'retirement',
      severity: 'high',
      status: 'Retiring',
    });
  });

  it('matches categories and services exactly (case-insensitive), title/text as whole words or phrases', () => {
    expect(
      classify(rules, item({ categories: ['Monitor'], title: 'Alerting update', summary: '' })),
    ).toBeNull();
    expect(
      classify(rules, item({ categories: [], title: 'x', summary: 'Changes to log analytics workspaces' })),
    ).toMatchObject({ areas: ['azure'] });
    expect(
      classify(rules, item({ categories: [], title: 'x', summary: '', services: ['exchange online'] })),
    ).toMatchObject({ areas: ['m365'], tags: ['exchange'], kind: 'info', severity: 'normal', status: null });
  });

  it('exclude drops the item even when other rules match', () => {
    expect(classify(rules, item({ categories: ['Azure Monitor', 'Azure Virtual Desktop'] }))).toBeNull();
  });

  it('keep: matched drops items no rule placed; keep: all gives them defaultAreas and keeps collector tags', () => {
    expect(classify(rules, item({ categories: ['Retirements'], title: 'x', summary: '' }))).toBeNull();
    const all = feed({ keep: 'all', defaultAreas: ['platform'], classify: [] });
    expect(classify(all, item({ tags: ['powershell'], kind: 'release' }))).toEqual({
      areas: ['platform'],
      tags: ['powershell'],
      kind: 'release',
      severity: 'normal',
      status: null,
    });
  });

  it('phrases need word boundaries ("Teams" is not "Teamsters") and span whitespace', () => {
    const teams = feed({
      keep: 'matched',
      classify: [{ match: { text: ['Microsoft Teams'] }, areas: ['m365'] }],
    });
    expect(classify(teams, item({ title: 'Microsoft   Teams: recap', categories: [] }))).not.toBeNull();
    expect(classify(teams, item({ title: 'Microsoft Teamsters', categories: [], summary: '' }))).toBeNull();
  });
});
