/**
 * Runs every page, dashboard and report datasource in portal/content (retired ones skipped) through the real engine —
 * DatasourceRunner + the outbound executor, exactly as the API runs them — against the fake Graph over the synthetic
 * tenant, one datasource at a time so every request, byte and millisecond is attributed to it.
 *
 * Measured per datasource: HTTP requests (pages; a $batch counts once, its sub-requests separately), bytes received,
 * wall time, time in the outbound executor (fetching and paging) and the rest (≈ transform), peak heap growth, result
 * rows, whether a `paging: all` crawl stopped with a nextLink still open (truncated at maxItems), throttled answers,
 * and errors. `estimatedLiveMs` = requests × `liveLatencyMs` (sequential pages, a typical Graph round trip) + the
 * transform time: what a person would wait against the real Graph.
 */
import path from 'node:path';
import { DatasourceRunner, fixtureRunner } from '@adminforge/api/src/datasources/executor';
import { FsDefinitionSource, registryFrom } from '@adminforge/api/src/definitions';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';
import type { FakeGraph } from '../graph/fake-graph';
import { NOW_ISO, type SyntheticTenant } from '../tenant/generate';
import { PERF_ENV, representativeParams } from './params';

export const CONTENT_DIR = path.join(repoRoot, 'portal/content');
const FIXTURES = path.join(repoRoot, 'tests/fixtures');
const PAGE_KINDS = new Set(['page', 'dashboard', 'report']);
const USER = {
  oid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
  name: 'Avery Engineer',
  roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Author', 'Playbook.Approver', 'Portal.Admin'],
};

export type Status = 'ok' | 'skipped' | 'error' | 'unmodelled' | 'timeout';

export interface Measure {
  key: string;
  kind: string;
  page: string;
  datasource: string;
  source: string;
  paging: string;
  maxItems: number | null;
  hasTransform: boolean;
  status: Status;
  code?: string;
  message?: string;
  requests: number;
  batchSubRequests: number;
  bytes: number;
  wallMs: number;
  outboundMs: number;
  transformMs: number;
  heapPeakMB: number;
  rows: number | null;
  truncated: boolean;
  throttled: number;
  estimatedLiveMs: number;
}

export interface RunOptions {
  /** Only pages whose key matches. */
  only?: RegExp;
  liveLatencyMs?: number;
  /** Per datasource. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

const rowsOf = (data: unknown): number | null => {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const k of ['value', 'rows', 'items']) if (Array.isArray(d[k])) return (d[k] as unknown[]).length;
  }
  return null;
};

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

export async function runAllDatasources(
  graph: FakeGraph,
  tenant: SyntheticTenant,
  opts: RunOptions = {},
): Promise<Measure[]> {
  const liveLatency = opts.liveLatencyMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const now = () => new Date(NOW_ISO);

  // Per-datasource counters, fed by the instrumented fetch.
  let cur = {
    requests: 0,
    sub: 0,
    bytes: 0,
    throttled: 0,
    lastNext: '' as string,
    followed: true,
    heapPeak: 0,
  };
  const instrumented: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : undefined;
    if (cur.lastNext && url === cur.lastNext) cur.followed = true;
    if (method === 'POST' && url.endsWith('/$batch') && body) {
      try {
        cur.sub += (JSON.parse(body) as { requests?: unknown[] }).requests?.length ?? 0;
      } catch {
        /* counted as one request */
      }
    }
    const a = await graph.handle(method, url, headers, body);
    cur.requests++;
    cur.bytes += a.body.length;
    if (a.status === 429) cur.throttled++;
    const at = a.body.lastIndexOf('"@odata.nextLink":"');
    if (a.status === 200 && at >= 0) {
      const end = a.body.indexOf('"', at + 19);
      cur.lastNext = a.body.slice(at + 19, end).replace(/\\\//g, '/');
      cur.followed = false;
    } else if (a.status === 200) cur.followed = true;
    cur.heapPeak = Math.max(cur.heapPeak, process.memoryUsage().heapUsed);
    return new Response(a.body, { status: a.status, headers: a.headers });
  };

  const outbound = createOutboundExecutor({
    config: {
      DATA_MODE: 'fixtures',
      AF_SPO_TENANT_NAME: 'example',
      OUTBOUND_CONCURRENCY: 16,
      OUTBOUND_USER_CONCURRENCY: 6,
      OUTBOUND_TIMEOUT_MS: 30_000,
      TOKEN_CACHE_KEY: undefined,
    } as never,
    broker: null,
    auth: null,
    automation: null,
    fetch: instrumented,
    env: () => PERF_ENV,
    now,
  } as never);
  let outboundMs = 0;
  const timedOutbound = new Proxy(outbound, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== 'execute' || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
      return async (...args: unknown[]) => {
        const s = performance.now();
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          outboundMs += performance.now() - s;
        }
      };
    },
  });
  const registry = registryFrom(new FsDefinitionSource(CONTENT_DIR), 'fs');
  const runner = new DatasourceRunner({
    definitions: registry,
    outbound: timedOutbound as never,
    runner: fixtureRunner(FIXTURES),
    env: () => PERF_ENV,
    now,
  } as never);

  const { definitions } = await loadContentDir(CONTENT_DIR);
  const pages = definitions
    .map(
      (d) =>
        d.def as unknown as {
          kind: string;
          id: string;
          status?: string;
          datasources?: Record<string, Record<string, unknown>>;
        },
    )
    .filter(
      (d) =>
        PAGE_KINDS.has(d.kind) &&
        d.status !== 'retired' &&
        d.datasources &&
        (!opts.only || opts.only.test(d.id)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const out: Measure[] = [];
  try {
    for (const def of pages) {
      let page: Awaited<ReturnType<DatasourceRunner['page']>>;
      let params: Record<string, unknown>;
      try {
        page = await runner.page(def.id);
        params = await runner.prepareParams(page, representativeParams(def.id, tenant), USER);
      } catch (err) {
        opts.log?.(`  ! ${def.id}: params — ${(err as Error).message}`);
        continue;
      }
      const names = Object.keys(def.datasources!);
      const done = new Map<string, { data: unknown; ok: boolean; optional: boolean }>();
      const order: string[] = [];
      const visit = (n: string, seen = new Set<string>()) => {
        if (order.includes(n) || seen.has(n)) return;
        seen.add(n);
        for (const d of runner.dependencies(page, n)) visit(d, seen);
        order.push(n);
      };
      names.forEach((n) => visit(n));

      for (const name of order) {
        const ds = def.datasources![name]!;
        const m: Measure = {
          key: `${def.id}#${name}`,
          kind: def.kind,
          page: def.id,
          datasource: name,
          source: String(ds.source),
          paging: String(ds.paging ?? 'none'),
          maxItems: typeof ds.maxItems === 'number' ? ds.maxItems : null,
          hasTransform: typeof ds.transform === 'string',
          status: 'ok',
          requests: 0,
          batchSubRequests: 0,
          bytes: 0,
          wallMs: 0,
          outboundMs: 0,
          transformMs: 0,
          heapPeakMB: 0,
          rows: null,
          truncated: false,
          throttled: 0,
          estimatedLiveMs: 0,
        };
        const deps = runner.dependencies(page, name);
        const failedDep = deps.find(
          (d) => !done.get(d)?.ok && !(def.datasources![d] as { optional?: boolean }).optional,
        );
        if (failedDep) {
          m.status = 'skipped';
          m.code = 'dependency_failed';
          m.message = `ds.${failedDep} failed`;
          out.push(m);
          done.set(name, { data: null, ok: false, optional: Boolean(ds.optional) });
          continue;
        }
        (globalThis as { gc?: () => void }).gc?.();
        const base = process.memoryUsage().heapUsed;
        cur = { requests: 0, sub: 0, bytes: 0, throttled: 0, lastNext: '', followed: true, heapPeak: base };
        outboundMs = 0;
        const started = performance.now();
        const unmodelledBefore = [...graph.stats.unmodelled.values()].reduce((s, n) => s + n, 0);
        let timer: NodeJS.Timeout | undefined;
        try {
          const res = await Promise.race([
            runner.run({
              identity: { kind: 'automation', mode: 'read' },
              user: USER,
              page,
              datasource: name,
              params,
              correlationId: `perf-${m.key}`,
              noCache: true,
              deps: Object.fromEntries(deps.map((d) => [d, done.get(d)?.data ?? null])),
              depErrors: {},
            } as never),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(Object.assign(new Error(`over ${timeoutMs / 1000} s`), { code: 'perf_timeout' })),
                timeoutMs,
              );
            }),
          ]);
          const r = res as { data: unknown; skipped?: boolean };
          m.status = r.skipped ? 'skipped' : 'ok';
          m.rows = rowsOf(r.data);
          done.set(name, { data: r.data, ok: true, optional: Boolean(ds.optional) });
        } catch (err) {
          const e = err as { code?: string; message?: string; status?: number };
          const unmodelledNow = [...graph.stats.unmodelled.values()].reduce((s, n) => s + n, 0);
          m.status =
            e.code === 'perf_timeout' ? 'timeout' : unmodelledNow > unmodelledBefore ? 'unmodelled' : 'error';
          m.code = e.code ?? 'error';
          m.message = (e.message ?? String(err)).slice(0, 300);
          done.set(name, { data: null, ok: false, optional: Boolean(ds.optional) });
        } finally {
          clearTimeout(timer);
        }
        m.wallMs = Math.round(performance.now() - started);
        m.outboundMs = Math.round(outboundMs);
        m.transformMs = Math.max(0, m.wallMs - m.outboundMs);
        m.requests = cur.requests;
        m.batchSubRequests = cur.sub;
        m.bytes = cur.bytes;
        m.throttled = cur.throttled;
        m.heapPeakMB = mb(Math.max(cur.heapPeak, process.memoryUsage().heapUsed) - base);
        m.truncated = m.paging === 'all' && !cur.followed && Boolean(cur.lastNext);
        m.estimatedLiveMs = m.requests * liveLatency + m.transformMs;
        out.push(m);
        opts.log?.(
          `  ${m.status === 'ok' ? '✓' : m.status === 'skipped' ? '·' : '✗'} ${m.key}  ${m.requests} req  ${mb(m.bytes)} MB  ${m.wallMs} ms (transform ${m.transformMs})${m.truncated ? '  TRUNCATED' : ''}${m.code ? `  ${m.code}` : ''}`,
        );
      }
    }
  } finally {
    registry.close();
  }
  return out;
}
