import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// m365.overview 1.1.1 sorts service issues and act-by messages with native order-bys instead of $sort with a
// comparator (which ran out of its 250 ms budget under load). These pin the order the comparators gave.
const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const datasources = (definitions.find((d) => d.def.id === 'm365.overview')!.def as Def).datasources;

const run = async (ds: string, value: unknown[]) =>
  (await renderString(datasources[ds].transform as string, {
    now: '2026-10-17T12:00:00Z',
    user: {},
    env: {},
    params: {},
    ds: {},
    value: { value },
  })) as Def;

const issue = (id: string, classification: string, lastModifiedDateTime: string, isResolved = false) => ({
  id,
  title: `Issue ${id}`,
  service: 'Exchange Online',
  classification,
  lastModifiedDateTime,
  isResolved,
});

describe('m365.overview sorts', () => {
  it('lists open incidents first, then advisories, each newest first', async () => {
    const out = await run('issues', [
      issue('a1', 'advisory', '2026-10-16T08:00:00Z'),
      issue('i1', 'incident', '2026-10-15T08:00:00Z'),
      issue('a2', 'advisory', '2026-10-17T08:00:00Z'),
      issue('i2', 'incident', '2026-10-17T09:00:00Z'),
      issue('r1', 'incident', '2026-10-17T10:00:00Z', true),
    ]);
    expect(out.rows.map((r: Def) => r.id)).toEqual(['i2', 'i1', 'a2', 'a1']);
    expect(out).toMatchObject({ incidents: 2, advisories: 2 });
    expect(Object.keys(out.rows[0])).toEqual([
      'id',
      'title',
      'service',
      'classification',
      'lastModifiedDateTime',
    ]);
  });

  it('returns a list for one issue and for none', async () => {
    expect((await run('issues', [issue('i1', 'incident', '2026-10-15T08:00:00Z')])).rows).toHaveLength(1);
    expect(await run('issues', [])).toMatchObject({ rows: [], incidents: 0, advisories: 0 });
  });

  it('lists messages to act on soonest first and drops those more than a week overdue', async () => {
    // $daysUntil counts from the real clock.
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    const msg = (id: string, actionRequiredByDateTime: string | null) => ({
      id,
      title: id,
      actionRequiredByDateTime,
    });
    const out = await run('messages', [
      msg('later', inDays(135)),
      msg('none', null),
      msg('overdue', inDays(-3)),
      msg('long-overdue', inDays(-46)),
      msg('soon', inDays(13)),
    ]);
    expect(out.actionRequired.map((m: Def) => [m.id, m.urgency])).toEqual([
      ['overdue', 'overdue'],
      ['soon', 'soon'],
      ['later', 'later'],
    ]);
    expect(out).toMatchObject({ count: 3, dueSoon: 2 });
    expect((await run('messages', [])).actionRequired).toEqual([]);
  });
});
