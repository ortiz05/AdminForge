import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SessionContext } from '../lib/session';
import { probesQuery, type ProbeItem, type ProbeStatus } from '../ops/schedules';

/**
 * The navigation rail's check status per section: a section key is also a probe `group` (`identity`, `exchange`, …),
 * so each section header can show how its own probes are doing and link to `/monitoring?group=<key>`. It reads the
 * same `GET /api/probes` as Synthetic monitoring (one cache entry, so the dot and the page always agree).
 */

export interface SectionCheck {
  /** The worst latest result among the section's probes (`unknown` only when none has a result yet). */
  status: ProbeStatus;
  counts: Record<ProbeStatus, number>;
}

/** Worst first. A probe with no result yet never hides one that has one. */
const RANK: Record<ProbeStatus, number> = { crit: 3, warn: 2, ok: 1, unknown: 0 };

/**
 * Probe results by group, which is the section key. Probes without a group are left out; AdminForge's own (`platform`)
 * are counted but match no section, so the rail shows no mark for them (Synthetic monitoring lists them).
 */
export function sectionChecks(items: readonly ProbeItem[]): Record<string, SectionCheck> {
  const out: Record<string, SectionCheck> = {};
  for (const p of items) {
    if (!p.group) continue;
    const status = p.latest?.status ?? 'unknown';
    const c = (out[p.group] ??= { status: 'unknown', counts: { crit: 0, warn: 0, ok: 0, unknown: 0 } });
    c.counts[status]++;
    if (RANK[status] > RANK[c.status]) c.status = status;
  }
  return out;
}

const WORDS: Array<[ProbeStatus, string]> = [
  ['crit', 'failing'],
  ['warn', 'degraded'],
  ['ok', 'healthy'],
  ['unknown', 'with no result yet'],
];

/** "1 failing, 2 degraded, 5 healthy" — worst first, only what's there. */
export function checksText(check: SectionCheck): string {
  return WORDS.filter(([s]) => check.counts[s] > 0)
    .map(([s, w]) => `${check.counts[s]} ${w}`)
    .join(', ');
}

const select = (data: { items: ProbeItem[] }) => sectionChecks(data.items);

export interface SectionChecks {
  /** Check status by section key; undefined while loading, when the viewer may not read probes, or on an error. */
  checks: Record<string, SectionCheck> | undefined;
  /** Still loading (the rail keeps the status column, so nothing moves when it answers). */
  pending: boolean;
}

/**
 * The rail's check status. GET /api/probes needs Portal.Reader, so it isn't asked without that role; when it fails the
 * rail simply shows no marks (a shell decoration never gets in the way).
 */
export function useSectionChecks(): SectionChecks {
  const me = useContext(SessionContext);
  const canRead = !!me?.roles.includes('Portal.Reader');
  const q = useQuery({
    ...probesQuery,
    select,
    enabled: canRead,
    // Synthetic monitoring polls every minute while it's open; the rail is content with every five.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  return { checks: q.data, pending: canRead && q.isPending };
}
