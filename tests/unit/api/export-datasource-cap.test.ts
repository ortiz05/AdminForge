import type { DatasourceRunner } from '@adminforge/api/src/datasources/executor';
import { exportPages, type ExportPlan } from '@adminforge/api/src/reports/export';

// A transformed (non-streamed) export reads at most the datasource's own maxItems — it is sized for its transform
// budget — never more because the export allows more; when that read stopped at its cap, the file says it's truncated.
const plan = (over: Partial<ExportPlan> = {}): ExportPlan => ({
  spec: { formats: ['csv'] } as ExportPlan['spec'],
  datasource: 'rows',
  path: ['rows'],
  columns: [],
  fileName: 'x.csv',
  streamable: false,
  maxRows: 100_000,
  ...over,
});

function runner(rows: number, truncated = false) {
  const calls: Array<{ maxItems?: number }> = [];
  const r = {
    run: async (input: { maxItems?: number }) => {
      calls.push({ maxItems: input.maxItems });
      return {
        data: { rows: Array.from({ length: rows }, (_, i) => ({ i })) },
        provenance: null,
        ...(truncated ? { truncated: true } : {}),
      };
    },
  } as unknown as DatasourceRunner;
  return { r, calls };
}

async function collect(r: DatasourceRunner, p: ExportPlan) {
  const pages = [];
  for await (const page of exportPages(r, {} as never, p)) pages.push(page);
  return pages;
}

describe('exports keep the datasource cap', () => {
  it('asks for the smaller of the export limit and the datasource maxItems', async () => {
    const { r, calls } = runner(10);
    await collect(r, plan({ datasourceCap: 40_000 }));
    expect(calls).toEqual([{ maxItems: 40_000 }]);
  });

  it('without a datasource cap the export limit applies', async () => {
    const { r, calls } = runner(10);
    await collect(r, plan());
    expect(calls).toEqual([{ maxItems: 100_000 }]);
  });

  it('a read that stopped at its cap marks the file truncated', async () => {
    const { r } = runner(10, true);
    const [page] = await collect(r, plan({ datasourceCap: 10 }));
    expect(page).toMatchObject({ truncated: true });
    expect(page!.rows).toHaveLength(10);
  });

  it('a complete read under both limits is not truncated', async () => {
    const { r } = runner(10);
    const [page] = await collect(r, plan({ datasourceCap: 40_000 }));
    expect(page).toMatchObject({ truncated: false });
  });
});
