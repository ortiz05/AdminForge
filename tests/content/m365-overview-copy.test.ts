import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Design review L17 (2026-10-21) on the Microsoft 365 overview: the "Teams without any owner" figure showed a status
// and a sentence-long hint, and at 1280–1440 px the hint was cut after "Action needed"; the daily-active-users legend
// read "Office365 / One drive / Share point" (field names, humanised). The figure has no hint beside its status (the
// report it opens explains app-owned teams) and the chart names its series.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const overview = loaded.definitions.find((d) => d.def.id === 'm365.overview')!.def as {
  layout: Array<Record<string, unknown>>;
};
const block = (id: string) => overview.layout.find((b) => b.id === id)!;

describe('Microsoft 365 overview copy', () => {
  it('content loads', () => {
    expect(loaded.errors).toEqual([]);
  });

  it('a figure that shows a status in the six-figure strip carries no hint beside it', () => {
    const kpis = overview.layout.filter((b) => b.widget === 'kpi');
    expect(kpis.length).toBe(6);
    expect(kpis.filter((b) => b.status !== undefined && b.hint !== undefined).map((b) => b.id)).toEqual([]);
    expect(block('teamsNoOwner').href).toBe('/p/m365.teams-without-owners');
  });

  it('the daily-active-users chart names every series', () => {
    const chart = block('activeUsers') as { y: string[]; labels?: Record<string, string> };
    expect(chart.y.filter((y) => !chart.labels?.[y])).toEqual([]);
    expect(chart.labels).toMatchObject({ oneDrive: 'OneDrive', sharePoint: 'SharePoint' });
  });
});
