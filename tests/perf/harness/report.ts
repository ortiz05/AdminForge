/**
 * Writes the perf suite's results to tests/perf/out/ (gitignored): `datasources.json` (every measure) and
 * `datasources.md` (ranked tables: slowest against the real Graph, biggest, failing, truncated, unmodelled paths).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Measure } from './run-datasources';

export const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'out');

const mb = (n: number) => (n / 1e6).toFixed(1);
const s = (ms: number) => (ms / 1000).toFixed(1);

export function writeReport(
  measures: Measure[],
  meta: Record<string, unknown>,
  unmodelled: Map<string, number>,
): string {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, 'datasources.json'),
    JSON.stringify({ meta, measures, unmodelled: Object.fromEntries(unmodelled) }, null, 2),
  );
  const by = (k: keyof Measure) => [...measures].sort((a, b) => Number(b[k]) - Number(a[k]));
  const counts = measures.reduce<Record<string, number>>(
    (acc, m) => ({ ...acc, [m.status]: (acc[m.status] ?? 0) + 1 }),
    {},
  );
  const row = (m: Measure) =>
    `| \`${m.key}\` | ${m.source}/${m.paging}${m.maxItems ? ` ≤${m.maxItems}` : ''} | ${m.status}${m.code ? ` (${m.code})` : ''} | ${m.requests}${m.batchSubRequests ? ` (+${m.batchSubRequests} in $batch)` : ''} | ${mb(m.bytes)} | ${m.transformMs} | ${m.heapPeakMB} | ${m.rows ?? '–'} | ${m.truncated ? 'yes' : ''} | ${s(m.estimatedLiveMs)} |`;
  const head =
    '| Datasource | Source/paging | Status | Requests | MB | Transform ms | Heap +MB | Rows | Truncated | ≈ live s |\n|---|---|---|---|---|---|---|---|---|---|';
  const md = [
    `# Datasources at ${String(meta.scale)} scale`,
    '',
    `Run ${String(meta.at)} on ${String(meta.host)}; ${measures.length} datasources (${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}); ≈ live = requests × ${String(meta.liveLatencyMs)} ms + transform.`,
    '',
    '## Slowest against the real Graph (≈ live)',
    head,
    ...by('estimatedLiveMs').slice(0, 30).map(row),
    '',
    '## Most data transferred',
    head,
    ...by('bytes').slice(0, 15).map(row),
    '',
    '## Failing',
    head,
    ...measures.filter((m) => m.status === 'error' || m.status === 'timeout').map(row),
    '',
    '## Truncated crawls (results silently cut at maxItems)',
    head,
    ...measures.filter((m) => m.truncated).map(row),
    '',
    '## Paths the synthetic tenant does not model',
    '',
    ...[...unmodelled.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${n} × \`${k}\``),
    '',
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, 'datasources.md'), md);
  return md;
}
