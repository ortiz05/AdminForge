/**
 * The fake Graph over the synthetic tenant as its own process (HTTP on 127.0.0.1), for the load test: the fake's own
 * work (scanning sign-ins, building pages) must not share the API's event loop, or it would be measured as API
 * latency. Started by perf/load.ts with `fork(…, { execArgv: ['--import', 'tsx'] })`; reports its port over IPC.
 *
 *   argv: <scale> <latencyMs> <jitterMs> [logScanBudget]
 */
import { createFakeGraph } from './graph/fake-graph';
import { createTenant, SCALES } from './tenant/generate';

const [scale = 'enterprise', latency = '0', jitter = '0', budget] = process.argv.slice(2);
const tenant = createTenant(SCALES[scale]!);
const graph = createFakeGraph(tenant, {
  latencyMs: Number(latency),
  jitterMs: Number(jitter),
  ...(budget ? { logScanBudget: Number(budget) } : {}),
});
const server = await graph.listen(0);
process.send?.({ url: server.url });
process.on('message', (m: { stats?: boolean }) => {
  if (m?.stats)
    process.send?.({
      stats: {
        requests: graph.stats.requests,
        maxInFlight: graph.stats.maxInFlight,
        throttled: graph.stats.throttled,
        bytes: graph.stats.bytes,
        busyMs: Math.round(graph.stats.busyMs),
        errors: graph.stats.errors,
        unmodelled: Object.fromEntries(graph.stats.unmodelled),
      },
    });
});
process.on('disconnect', () => process.exit(0));
