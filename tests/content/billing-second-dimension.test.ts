import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Cost analysis and chargeback with and without a second dimension ("Then by"): without one, rows carry no detail
// line — JSONata's $exists(null) is true, so an index set to null for "no second dimension" used to label every row
// "(not assigned)".
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ds = (id: string, name: string): any =>
  (loaded.definitions.find((d) => d.def.id === id)!.def as { datasources: Record<string, unknown> })
    .datasources[name];

const answer = (columns: string[], rows: unknown[][]) => ({
  properties: { columns: columns.map((name) => ({ name })), rows },
});

describe('cost analysis "Then by"', () => {
  const transform = ds('billing.cost-analysis', 'cost').transform as string;
  const run = (params: Record<string, unknown>, value: unknown) =>
    renderString(transform, { params, value, now: '2026-10-15T12:00:00Z', env: {}, ds: {} }) as Promise<{
      rows: Array<{ group: string; detail: string | null }>;
    }>;

  it('has no detail line without a second dimension', async () => {
    const out = await run(
      { groupBy: 'ServiceName', thenBy: 'None' },
      answer(
        ['Cost', 'ServiceName', 'Currency'],
        [
          [120.5, 'Virtual Machines', 'EUR'],
          [30, 'Storage', 'EUR'],
        ],
      ),
    );
    expect(out.rows.map((r) => [r.group, r.detail ?? null])).toEqual([
      ['Virtual Machines', null],
      ['Storage', null],
    ]);
  });

  it('shows the second dimension, or "(not assigned)" where Cost Management has none', async () => {
    const out = await run(
      { groupBy: 'ServiceName', thenBy: 'ResourceGroupName' },
      answer(
        ['Cost', 'ServiceName', 'ResourceGroupName', 'Currency'],
        [
          [120.5, 'Virtual Machines', 'rg-app', 'EUR'],
          [30, 'Storage', '', 'EUR'],
        ],
      ),
    );
    expect(out.rows.map((r) => [r.group, r.detail])).toEqual([
      ['Virtual Machines', 'rg-app'],
      ['Storage', '(not assigned)'],
    ]);
  });
});
