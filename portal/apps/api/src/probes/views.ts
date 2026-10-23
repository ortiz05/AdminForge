import type { Navigation, Probe } from '@adminforge/schemas';
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
  /** The service it watches (`group`: a navigation section key, or `platform`), or null. */
  group: string | null;
  /** What it checks and why it matters (the probe's summary). */
  summary: string | null;
  /** What to do when it warns or fails, and where to act (the probe's `remedy` and `link`). */
  remedy: string | null;
  link: { label: string; href: string } | null;
  /** The probe's tags (what sweeps select it by, and Monitoring's tag filter). */
  tags: string[];
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

/** A service group on Synthetic monitoring: a navigation section's label and icon, or AdminForge itself. */
export interface ProbeGroup {
  key: string;
  label: string;
  icon: string;
}

/** `platform`: probes of AdminForge itself (readiness, audit chain, its certificate, its tokens). */
export const PLATFORM_GROUP: ProbeGroup = { key: 'platform', label: 'AdminForge', icon: 'gauge' };

/** The groups the probes use, in navigation order (then AdminForge, then any other key). */
export function probeGroups(navigation: Navigation | undefined, present: Iterable<string>): ProbeGroup[] {
  const keys = new Set(present);
  const out: ProbeGroup[] = [];
  const sections = [...(navigation?.sections ?? [])]
    .map((s, index) => ({ s, index }))
    .sort((a, b) => (a.s.order ?? 1000) - (b.s.order ?? 1000) || a.index - b.index);
  for (const { s } of sections)
    if (keys.delete(s.key)) out.push({ key: s.key, label: s.label, icon: s.icon });
  if (keys.delete(PLATFORM_GROUP.key)) out.push(PLATFORM_GROUP);
  for (const key of [...keys].sort())
    out.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1), icon: 'pulse' });
  return out;
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

  async list(): Promise<{ items: ProbeItem[]; groups: ProbeGroup[] }> {
    const now = this.deps.now();
    const [records, latest, series, navs] = await Promise.all([
      this.deps.definitions.list('probe'),
      this.deps.store.latestProbeResults(),
      this.deps.store.probeSeries(new Date(now.getTime() - SERIES_WINDOW_MS), SERIES_POINTS),
      this.deps.definitions.list('navigation'),
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
          group: probe.group ?? null,
          summary: probe.summary ?? null,
          remedy: probe.remedy ?? null,
          link: probe.link ?? null,
          tags: probe.tags ?? [],
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
    const navigation = (navs.find((n) => n.key === 'portal.navigation') ?? navs[0])?.def as
      Navigation | undefined;
    return {
      items,
      groups: probeGroups(
        navigation,
        items.flatMap((i) => (i.group ? [i.group] : [])),
      ),
    };
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
