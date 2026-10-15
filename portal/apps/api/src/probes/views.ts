import type { Probe } from '@adminforge/schemas';
import type { DefinitionSource } from '../definitions/types';
import { AppError } from '../errors';
import type { ScheduleStore } from '../schedules/store';
import type { ProbeStatus } from '../schedules/types';
import { effectiveThresholds } from './thresholds';

/** Probe status for the monitoring pages: `GET /api/probes` and `GET /api/probes/:key/results`. */

export interface ProbeItem {
  key: string;
  title: string;
  kind: string;
  latest: {
    status: ProbeStatus;
    metric: number | null;
    unit: string;
    ts: string;
    message: string | null;
  } | null;
  series: Array<{ ts: string; metric: number | null; status: ProbeStatus }>;
  thresholds: { warn: number | null; crit: number | null; unit: string; worse: 'higher' | 'lower' };
}

export interface ProbeResultItem {
  ts: string;
  status: ProbeStatus;
  metric: number | null;
  unit: string;
  durationMs: number | null;
  message: string | null;
  details: unknown;
  scheduleRunId: string | null;
}

export const SERIES_WINDOW_MS = 24 * 3_600_000;
export const SERIES_POINTS = 96;
export const RESULTS_LIMIT = 500;
const MAX_RANGE_MS = 31 * 86_400_000;

export class ProbeViews {
  constructor(
    private readonly deps: {
      store: ScheduleStore;
      definitions: Pick<DefinitionSource, 'list' | 'get'>;
      now: () => Date;
    },
  ) {}

  async list(): Promise<{ items: ProbeItem[] }> {
    const now = this.deps.now();
    const [records, latest, series] = await Promise.all([
      this.deps.definitions.list('probe'),
      this.deps.store.latestProbeResults(),
      this.deps.store.probeSeries(new Date(now.getTime() - SERIES_WINDOW_MS), SERIES_POINTS),
    ]);
    const latestBy = new Map(latest.map((r) => [r.probeKey, r]));
    const seriesBy = new Map<string, typeof series>();
    for (const r of series) seriesBy.set(r.probeKey, [...(seriesBy.get(r.probeKey) ?? []), r]);
    const items = records
      .map((rec) => {
        const probe = rec.def as Probe;
        const t = effectiveThresholds(probe);
        const l = latestBy.get(rec.key);
        return {
          key: rec.key,
          title: probe.title,
          kind: probe.check.kind,
          latest: l
            ? { status: l.status, metric: l.metric, unit: t.unit, ts: l.ts.toISOString(), message: l.message }
            : null,
          series: (seriesBy.get(rec.key) ?? [])
            .sort((a, b) => a.ts.getTime() - b.ts.getTime())
            .map((p) => ({ ts: p.ts.toISOString(), metric: p.metric, status: p.status })),
          thresholds: { warn: t.warn, crit: t.crit, unit: t.unit, worse: t.worse },
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
    return { items };
  }

  /** One probe's results since `since` (default 24 h; at most 31 days), newest first, with details rows. */
  async results(key: string, since?: string): Promise<{ items: ProbeResultItem[] }> {
    const now = this.deps.now();
    let from = new Date(now.getTime() - SERIES_WINDOW_MS);
    if (since) {
      const d = new Date(since);
      if (Number.isNaN(d.getTime()))
        throw new AppError(400, 'invalid_request', 'since must be an ISO date-time.');
      from = new Date(Math.max(d.getTime(), now.getTime() - MAX_RANGE_MS));
    }
    const rec = await this.deps.definitions.get('probe', key);
    const rows = await this.deps.store.probeResults(key, from, RESULTS_LIMIT);
    if (!rec && !rows.length) throw new AppError(404, 'probe_not_found', `No probe "${key}".`);
    const unit = rec ? effectiveThresholds(rec.def as Probe).unit : '';
    return {
      items: rows.map((r) => ({
        ts: r.ts.toISOString(),
        status: r.status,
        metric: r.metric,
        unit,
        durationMs: r.durationMs,
        message: r.message,
        details: r.details ?? null,
        scheduleRunId: r.scheduleRunId,
      })),
    };
  }
}
