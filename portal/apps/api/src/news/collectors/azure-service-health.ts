import type { FeedCollector, NewsKind, NewsSeverity } from '@adminforge/schemas';
import { runKql } from '../../probes/kql';
import { htmlToText } from '../text';
import type { Candidate } from '../types';
import { AUTOMATION_READ, day, facts, humanize, isoDate, str, type Collector } from './shared';

/**
 * Azure Service Health events of every subscription the automation identity can read (Reader), from Azure Resource
 * Graph `servicehealthresources` (type microsoft.resourcehealth/events). One event appears once per subscription it
 * affects; items are merged by tracking id. Property names (PascalCase) are read case-insensitively and may be missing;
 * dates may be epoch milliseconds or ISO strings. EventSubType Retirement → retirement.
 */

type AzureServiceHealth = Extract<FeedCollector, { kind: 'azureServiceHealth' }>;
type EventType = NonNullable<AzureServiceHealth['eventTypes']>[number];

const TRACKING_ID = /^[A-Za-z0-9_-]{1,40}$/;
const SERVICE_HEALTH_BLADE =
  'https://portal.azure.com/#view/Microsoft_Azure_Health/AzureHealthBrowseBlade/~/serviceIssues';

/**
 * The documented Service Health short link: https://app.azure.com/h/<TrackingId>/<first 3 + last 3 characters of the
 * subscription id>. Falls back to the portal's Service Health page when either part doesn't look right.
 */
export function azureServiceHealthLink(trackingId: string, subscriptionId: string | null): string {
  const sub = (subscriptionId ?? '').replace(/[^A-Za-z0-9-]/g, '');
  if (!TRACKING_ID.test(trackingId) || sub.length < 6) return SERVICE_HEALTH_BLADE;
  return `https://app.azure.com/h/${trackingId}/${sub.slice(0, 3)}${sub.slice(-3)}`;
}

/** Case-insensitive property read. */
function prop(obj: unknown, name: string): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  if (name in o) return o[name];
  const lower = name.toLowerCase();
  const key = Object.keys(o).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : o[key];
}

const KIND: Record<string, NewsKind> = {
  ServiceIssue: 'incident',
  PlannedMaintenance: 'maintenance',
  HealthAdvisory: 'advisory',
  SecurityAdvisory: 'security',
};

const canonicalType = (raw: string) =>
  Object.keys(KIND).find((k) => k.toLowerCase() === raw.trim().toLowerCase()) ?? raw.trim();

function severityOf(eventType: string, level: string): NewsSeverity {
  const l = level.toLowerCase();
  if (l === 'critical') return 'critical';
  if (l === 'error' || eventType === 'ServiceIssue' || eventType === 'SecurityAdvisory') return 'high';
  return 'normal';
}

export interface AzureEventGroup {
  properties: Record<string, unknown>;
  /** The subscription of the copy kept (for the short link). */
  subscriptionId: string | null;
  subscriptions: number;
}

/** Event types the collector reads (others — RCA, EmergingIssues, Billing — are ignored). */
export const AZURE_EVENT_TYPES = [
  'ServiceIssue',
  'PlannedMaintenance',
  'HealthAdvisory',
  'SecurityAdvisory',
] as const;

/** One event (the most recently updated copy over all subscriptions) → candidate. */
export function azureEventToCandidate(group: AzureEventGroup, now: Date): Candidate | null {
  const p = group.properties;
  const trackingId = str(prop(p, 'TrackingId')).trim();
  const title = str(prop(p, 'Title')).trim();
  if (!trackingId || !title) return null;
  const eventType = canonicalType(str(prop(p, 'EventType')));
  let kind: NewsKind = KIND[eventType] ?? 'advisory';
  if (
    kind === 'advisory' &&
    (str(prop(p, 'EventSubType')).toLowerCase() === 'retirement' ||
      /\bretir(e|es|ed|ing|ement)\b/i.test(title))
  )
    kind = 'retirement';
  const rawStatus = str(prop(p, 'Status')).trim();
  const status = rawStatus ? rawStatus.toLowerCase() : null;
  const impact = prop(p, 'Impact');
  const impacts = Array.isArray(impact) ? impact : [];
  const services = [...new Set(impacts.map((i) => str(prop(i, 'ImpactedService')).trim()).filter(Boolean))];
  const regions = [
    ...new Set(
      impacts.flatMap((i) => {
        const rs = prop(i, 'ImpactedRegions');
        return (Array.isArray(rs) ? rs : [])
          .map((r) => str(prop(r, 'ImpactedRegion')).trim())
          .filter(Boolean);
      }),
    ),
  ];
  const start = isoDate(prop(p, 'ImpactStartTime'));
  const mitigated = isoDate(prop(p, 'ImpactMitigationTime'));
  const updated = isoDate(prop(p, 'LastUpdateTime'));
  const publishedAt = start && start.getTime() <= now.getTime() ? start : (updated ?? start ?? now);
  const level = str(prop(p, 'EventLevel')) || str(prop(p, 'Level'));
  return {
    externalId: trackingId,
    title,
    summary: htmlToText(str(prop(p, 'Summary')) || str(prop(p, 'Header'))),
    url: azureServiceHealthLink(trackingId, group.subscriptionId),
    kind,
    severity: severityOf(eventType, level),
    status,
    publishedAt,
    updatedAt: updated && updated.getTime() !== publishedAt.getTime() ? updated : null,
    actionRequiredBy: kind === 'maintenance' ? start : null,
    services,
    categories: [eventType].filter(Boolean),
    tags: [],
    audience: [],
    facts: facts([
      ['Tracking ID', trackingId],
      ['Event type', humanize(eventType)],
      ['Status', rawStatus],
      ['Services', services.join(', ')],
      ['Regions', regions.join(', ')],
      ['Impact start', day(start)],
      ['Mitigated', day(mitigated)],
      ['Subscriptions affected', String(group.subscriptions)],
      [
        'Details',
        eventType === 'SecurityAdvisory'
          ? 'The full advisory needs an elevated Azure role (Service Health Security Reader).'
          : null,
      ],
    ]),
  };
}

/** Merges per-subscription copies by tracking id, keeping the most recently updated one. */
export function groupEvents(rows: Array<Record<string, unknown>>): AzureEventGroup[] {
  const groups = new Map<
    string,
    { properties: Record<string, unknown>; updated: number; sub: string | null; subs: Set<string> }
  >();
  for (const row of rows) {
    const p = prop(row, 'properties');
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const props = p as Record<string, unknown>;
    const id = str(prop(props, 'TrackingId')).trim();
    if (!id) continue;
    const updated = isoDate(prop(props, 'LastUpdateTime'))?.getTime() ?? 0;
    const sub = str(prop(row, 'subscriptionId'));
    const g = groups.get(id);
    if (!g) groups.set(id, { properties: props, updated, sub: sub || null, subs: new Set(sub ? [sub] : []) });
    else {
      if (sub) g.subs.add(sub);
      if (updated > g.updated) {
        g.properties = props;
        g.updated = updated;
        g.sub = sub || g.sub;
      }
    }
  }
  return [...groups.values()].map((g) => ({
    properties: g.properties,
    subscriptionId: g.sub,
    subscriptions: Math.max(1, g.subs.size),
  }));
}

export const collectAzureServiceHealth: Collector<AzureServiceHealth> = async (ctx, deps) => {
  const c = ctx.feed.collector;
  const now = deps.now();
  // Dates in these events may be epoch milliseconds or ISO strings, so the age filter runs here, not in KQL.
  // Nothing is interpolated into the query.
  const query = [
    '// af:news.azure-service-health',
    'servicehealthresources',
    "| where type =~ 'microsoft.resourcehealth/events'",
    '| project subscriptionId, properties',
  ].join('\n');
  const result = await runKql(
    AUTOMATION_READ,
    deps.outbound,
    { source: 'resourceGraph', query, maxRows: 5_000 },
    { signal: ctx.signal, correlationId: ctx.correlationId },
  );
  const wanted = new Set<string>((c.eventTypes as EventType[] | undefined) ?? AZURE_EVENT_TYPES);
  const oldest = now.getTime() - c.lookbackDays * 86_400_000;
  const candidates = groupEvents(result.rows)
    .map((g) => azureEventToCandidate(g, now))
    .filter((x): x is Candidate => x !== null)
    .filter((x) => x.categories.some((t) => wanted.has(t)))
    .filter((x) => (x.updatedAt ?? x.publishedAt).getTime() >= oldest)
    .sort((a, b) => (b.updatedAt ?? b.publishedAt).getTime() - (a.updatedAt ?? a.publishedAt).getTime())
    .slice(0, c.maxItems);
  return { candidates };
};
