/**
 * Load test (run by hand): many signed-in engineers loading pages at once against the real API (Fastify, in-process,
 * Entra auth with the tests' fake Entra client, live data mode) whose Microsoft Graph is the fake one over the
 * synthetic enterprise tenant. Each session loops: pick a page from the mix, POST /api/datasources/execute-many (what
 * the browser sends), think, repeat.
 *
 *   pnpm --filter @adminforge/tests exec tsx perf/load.ts [--sessions 1000] [--duration 60] [--think 4000]
 *        [--latency 120] [--scale enterprise|large|small] [--nat] [--rate-limit 600] [--mix default|light]
 *        [--fakes 8] [--scan-budget 50000] [--set KEY=VALUE …] [--tag name]
 *
 * --latency: fake Graph round trip in ms (with ±30% jitter). --nat: every session from one IP (a corporate NAT; the API
 * rate-limits per IP); default: one IP per session. --rate-limit: RATE_LIMIT_PER_MINUTE for the run (default: the
 * API's default). --fakes: fake Graph processes, round-robin (the fake must not be the bottleneck). --scan-budget:
 * sign-in/audit rows a fake scans per page. --set: API configuration for the run (e.g. OUTBOUND_CONCURRENCY=64).
 * --tag: added to the output file name. Output: a summary on stdout and tests/perf/out/load-<sessions>.json.
 */
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { entraConfig, FakeAuthClient } from '../api/helpers';
import { buildTestApp, sessionFor } from '../api/support/app';
import { Clock } from '../lib/clock';
import { repoRoot } from '../lib/repo';
import { createTenant, SCALES, type SyntheticTenant } from './tenant/generate';

process.env.NODE_ENV = 'test';

const { values: args } = parseArgs({
  options: {
    sessions: { type: 'string', default: '1000' },
    duration: { type: 'string', default: '60' },
    think: { type: 'string', default: '4000' },
    latency: { type: 'string', default: '120' },
    scale: { type: 'string', default: 'enterprise' },
    nat: { type: 'boolean', default: false },
    'rate-limit': { type: 'string' },
    mix: { type: 'string', default: 'default' },
    fakes: { type: 'string', default: '8' },
    'scan-budget': { type: 'string', default: '50000' },
    set: { type: 'string', multiple: true, default: [] },
    tag: { type: 'string' },
  },
});

const SESSIONS = Number(args.sessions);
const DURATION_MS = Number(args.duration) * 1000;
const THINK_MS = Number(args.think);

interface PageLoad {
  page: string;
  weight: number;
  params?: (t: SyntheticTenant, r: number) => Record<string, unknown>;
}
const pick = <T>(list: readonly T[], r: number) => list[Math.floor(r * list.length) % list.length]!;
const MIXES: Record<string, PageLoad[]> = {
  // What an engineering team does most: lists and entity pages, some dashboards and reports.
  default: [
    { page: 'identity.users', weight: 20 },
    { page: 'identity.user', weight: 15, params: (t, r) => ({ id: pick(t.users, r).id }) },
    { page: 'identity.groups', weight: 10 },
    { page: 'identity.group', weight: 6, params: (t, r) => ({ id: pick(t.groups, r).id }) },
    { page: 'endpoint.devices', weight: 8 },
    { page: 'endpoint.device', weight: 5, params: (t, r) => ({ id: pick(t.managedDevices, r).id }) },
    { page: 'identity.sign-ins', weight: 8 },
    { page: 'identity.audit-logs', weight: 4 },
    { page: 'identity.enterprise-apps', weight: 4 },
    { page: 'identity.health', weight: 3 },
    { page: 'm365.overview', weight: 3 },
    { page: 'security.overview', weight: 3 },
    { page: 'identity.privileged-role-assignments', weight: 2 },
    { page: 'identity.inactive-guests', weight: 2 },
    { page: 'm365.licences', weight: 3 },
  ],
  // Lists and entity pages only (what should always be fast).
  light: [
    { page: 'identity.users', weight: 30 },
    { page: 'identity.user', weight: 25, params: (t, r) => ({ id: pick(t.users, r).id }) },
    { page: 'identity.groups', weight: 20 },
    { page: 'endpoint.devices', weight: 15 },
    { page: 'identity.sign-ins', weight: 10 },
  ],
};

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;

async function main() {
  const scale = SCALES[args.scale!]!;
  const t0 = performance.now();
  const tenant = createTenant(scale);
  const genMs = Math.round(performance.now() - t0);
  // The fake Graph runs in its own processes (round-robin): its work must not count as API latency.
  const fakes = Array.from({ length: Number(args.fakes) }, () =>
    fork(
      path.join(repoRoot, 'tests/perf/fake-server.ts'),
      [
        scale.name,
        String(Number(args.latency) * 0.7),
        String(Number(args.latency) * 0.6),
        args['scan-budget']!,
      ],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    ),
  );
  const bases = await Promise.all(
    fakes.map(
      (child) =>
        new Promise<string>((resolve, reject) => {
          child.once('message', (m: { url?: string }) =>
            m.url ? resolve(m.url) : reject(new Error('fake Graph did not start')),
          );
          child.once('exit', (code) => reject(new Error(`fake Graph exited (${code})`)));
        }),
    ),
  );
  type GraphStats = {
    requests: number;
    maxInFlight: number;
    throttled: number;
    bytes: number;
    busyMs: number;
  };
  const graphStats = async (): Promise<GraphStats> => {
    const all = await Promise.all(
      fakes.map(
        (child) =>
          new Promise<GraphStats>((resolve) => {
            child.once('message', (m: { stats?: GraphStats }) => resolve(m.stats!));
            child.send({ stats: true });
          }),
      ),
    );
    return all.reduce((a, b) => ({
      busyMs: a.busyMs + b.busyMs,
      requests: a.requests + b.requests,
      maxInFlight: a.maxInFlight + b.maxInFlight,
      throttled: a.throttled + b.throttled,
      bytes: a.bytes + b.bytes,
    }));
  };
  let rr = 0;
  const graphFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://graph.microsoft.com/'))
      return new Response(
        JSON.stringify({
          error: { code: 'SyntheticNotModelled', message: `not modelled: ${new URL(url).hostname}` },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    return fetch(url.replace('https://graph.microsoft.com', bases[rr++ % bases.length]!), init);
  };
  const auth = new FakeAuthClient();
  const config = entraConfig({
    CONTENT_DIR: path.join(repoRoot, 'portal/content'),
    CONTENT_WATCH: 'false',
    ...(args['rate-limit'] ? { RATE_LIMIT_PER_MINUTE: args['rate-limit'] } : {}),
    ...Object.fromEntries(
      (args.set ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    ),
  });
  const clock = new Clock();
  // A real clock: the load test runs in wall time (sessions, caches and rate limits must age).
  (clock as unknown as { now: () => Date }).now = () => new Date();
  const built = await buildTestApp(config, { clock, deps: { auth, fetch: graphFetch } });
  await built.app.ready();

  const mix = MIXES[args.mix!] ?? MIXES.default!;
  const totalWeight = mix.reduce((s, m) => s + m.weight, 0);
  const choose = () => {
    let r = Math.random() * totalWeight;
    for (const m of mix) if ((r -= m.weight) < 0) return m;
    return mix[mix.length - 1]!;
  };

  const sessions: Array<Awaited<ReturnType<typeof sessionFor>>> = [];
  for (let i = 0; i < SESSIONS; i++) {
    const person = {
      oid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      upn: `engineer${i}@example.com`,
    };
    sessions.push(
      await sessionFor(
        { app: built.app, sessions: built.sessions, clock: { now: () => new Date() } },
        person,
        ['Portal.Reader', 'Portal.Operator'],
      ),
    );
  }

  const latencies: number[] = [];
  const byPage = new Map<string, number[]>();
  const statuses: Record<string, number> = {};
  const dsErrors: Record<string, number> = {};
  let dsTotal = 0;
  let cacheHits = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let peakRss = 0;
  const memTimer = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 500);
  const graphBefore = (await graphStats()).requests;
  const started = Date.now();
  const deadline = started + DURATION_MS;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const loop = async (i: number) => {
    await sleep(Math.random() * Math.min(10_000, DURATION_MS / 3)); // ramp-up
    const s = sessions[i]!;
    const ip = args.nat ? '10.0.0.1' : `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    while (Date.now() < deadline) {
      const load = choose();
      const params = load.params?.(tenant, Math.random()) ?? {};
      const at = performance.now();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const res = await built.app.inject({
          method: 'POST',
          url: '/api/datasources/execute-many',
          headers: { ...s.headers, 'content-type': 'application/json', 'user-agent': 'af-load' },
          remoteAddress: ip,
          payload: { page: load.page, params },
        });
        const ms = performance.now() - at;
        latencies.push(ms);
        (byPage.get(load.page) ?? byPage.set(load.page, []).get(load.page)!).push(ms);
        const key =
          res.statusCode === 200
            ? '200'
            : `${res.statusCode} ${(res.json() as { error?: { code?: string } })?.error?.code ?? ''}`;
        statuses[key] = (statuses[key] ?? 0) + 1;
        if (res.statusCode === 200) {
          const body = res.json() as {
            results: Record<string, { error?: { code: string }; provenance?: { cachedAt?: string } | null }>;
          };
          for (const r of Object.values(body.results)) {
            dsTotal++;
            if (r.error) dsErrors[r.error.code] = (dsErrors[r.error.code] ?? 0) + 1;
            else if (r.provenance?.cachedAt) cacheHits++;
          }
        }
      } catch (err) {
        statuses[`exception ${(err as Error).message.slice(0, 60)}`] = (statuses[`exception`] ?? 0) + 1;
      } finally {
        inFlight--;
      }
      await sleep(THINK_MS * (0.5 + Math.random()));
    }
  };
  await Promise.all(sessions.map((_, i) => loop(i)));
  const elapsed = (Date.now() - started) / 1000;
  clearInterval(memTimer);
  lag.disable();
  await built.app.close();
  const g = await graphStats();
  for (const child of fakes) child.disconnect();

  const sorted = [...latencies].sort((a, b) => a - b);
  const summary = {
    at: new Date().toISOString(),
    host: `${os.cpus().length} × ${os.cpus()[0]?.model ?? 'cpu'}, ${Math.round(os.totalmem() / 2 ** 30)} GB, Node ${process.version}`,
    scale: scale.name,
    tenantGeneratedMs: genMs,
    sessions: SESSIONS,
    durationS: elapsed,
    thinkMs: THINK_MS,
    graphLatencyMs: Number(args.latency),
    nat: args.nat,
    mix: args.mix,
    settings: args.set,
    requests: latencies.length,
    throughputPerS: Math.round((latencies.length / elapsed) * 10) / 10,
    latencyMs: {
      p50: Math.round(pct(sorted, 50)),
      p95: Math.round(pct(sorted, 95)),
      p99: Math.round(pct(sorted, 99)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
    },
    statuses,
    datasources: {
      total: dsTotal,
      cacheHitRate: dsTotal ? Math.round((cacheHits / dsTotal) * 1000) / 1000 : 0,
      errors: dsErrors,
    },
    maxConcurrentPageLoads: maxInFlight,
    graph: {
      requests: g.requests - graphBefore,
      maxInFlight: g.maxInFlight,
      throttled: g.throttled,
      megabytes: Math.round(g.bytes / 1e6),
      fakeBusyPercent: Math.round((g.busyMs / (elapsed * 1000 * fakes.length)) * 100),
    },
    eventLoopDelayMs: {
      p50: Math.round(lag.percentile(50) / 1e6),
      p99: Math.round(lag.percentile(99) / 1e6),
      max: Math.round(lag.max / 1e6),
    },
    peakRssMB: Math.round(peakRss / 2 ** 20),
    byPage: Object.fromEntries(
      [...byPage].map(([p, l]) => {
        const s = [...l].sort((a, b) => a - b);
        return [p, { n: l.length, p50: Math.round(pct(s, 50)), p95: Math.round(pct(s, 95)) }];
      }),
    ),
  };
  const out = path.join(repoRoot, 'tests/perf/out');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    path.join(
      out,
      `load-${SESSIONS}${args.nat ? '-nat' : ''}${args.mix !== 'default' ? `-${args.mix}` : ''}${args.tag ? `-${args.tag}` : ''}.json`,
    ),
    JSON.stringify(summary, null, 2),
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
