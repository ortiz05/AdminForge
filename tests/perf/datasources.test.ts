import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeGraph } from './graph/fake-graph';
import { check, loadBudgets, notes, record, writeBudgets } from './harness/budgets';
import { OUT_DIR, writeReport } from './harness/report';
import { runAllDatasources } from './harness/run-datasources';
import { createTenant, SCALES } from './tenant/generate';

// Every page, dashboard and report datasource against the synthetic enterprise tenant, with budgets
// (tests/perf/README.md). `pnpm test:perf` sets AF_PERF=1; plain `vitest` (watch) skips this suite.
// AF_PERF_SCALE=small|large|enterprise (default enterprise), AF_PERF_ONLY=<regex on page keys>,
// AF_PERF_RECORD=1 rewrites tests/perf/budgets.json from this run.

describe.skipIf(!process.env.AF_PERF)('datasources at enterprise scale', () => {
  it('stay within their budgets', async () => {
    const budgets = loadBudgets();
    const scale = SCALES[process.env.AF_PERF_SCALE ?? budgets.scale]!;
    const started = performance.now();
    const tenant = createTenant(scale);
    const generatedMs = Math.round(performance.now() - started);
    const graph = createFakeGraph(tenant);
    const only = process.env.AF_PERF_ONLY ? new RegExp(process.env.AF_PERF_ONLY) : undefined;
    const measures = await runAllDatasources(graph, tenant, {
      only,
      liveLatencyMs: budgets.liveLatencyMs,
      log: process.env.AF_PERF_VERBOSE ? (l) => process.stdout.write(`${l}\n`) : undefined,
    });
    const md = writeReport(
      measures,
      {
        scale: scale.name,
        at: new Date().toISOString(),
        host: `${os.cpus().length} × ${os.cpus()[0]?.model ?? 'cpu'}, ${Math.round(os.totalmem() / 2 ** 30)} GB, Node ${process.version}`,
        liveLatencyMs: budgets.liveLatencyMs,
        tenantGeneratedMs: generatedMs,
        runMs: Math.round(performance.now() - started),
      },
      graph.stats.unmodelled,
    );
    if (process.env.AF_PERF_RECORD) {
      writeBudgets(record(measures, budgets));
      return;
    }
    const problems = measures.flatMap((m) => check(m, budgets).map((p) => `${m.key}: ${p}`));
    // A budget entry for a datasource that no longer exists is stale.
    const keys = new Set(measures.map((m) => m.key));
    if (!only)
      for (const k of Object.keys(budgets.datasources))
        if (!keys.has(k))
          problems.push(`${k}: no such datasource any more — remove it from tests/perf/budgets.json`);
    const improvements = measures.flatMap((m) => notes(m, budgets).map((n) => `${m.key}: ${n}`));
    if (improvements.length)
      process.stdout.write(`\nImprovements (update tests/perf/budgets.json):\n${improvements.join('\n')}\n`);
    writeFileSync(path.join(OUT_DIR, 'problems.txt'), problems.join('\n'));
    if (problems.length) process.stderr.write(`\n${problems.join('\n')}\n`);
    expect(problems, `See tests/perf/out/datasources.md (${md.length} characters).`).toEqual([]);
  });
});
