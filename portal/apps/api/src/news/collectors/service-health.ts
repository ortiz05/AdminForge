import type { FeedCollector } from '@adminforge/schemas';
import { htmlToText } from '../text';
import type { Candidate } from '../types';
import { day, facts, graphChangedSince, humanize, isoDate, same, since, str, type Collector } from './shared';

/**
 * Microsoft 365 service health issues (Graph GET /admin/serviceAnnouncement/issues, application permission
 * ServiceHealth.Read.All), as the automation identity: incidents and advisories modified since the last run.
 */

type ServiceHealth = Extract<FeedCollector, { kind: 'serviceHealth' }>;

/** The admin center has no documented per-issue link: cite Service health (the issue id is in the facts). */
export const SERVICE_HEALTH_LINK = 'https://admin.cloud.microsoft/?ref=servicehealth';

const SELECT =
  'id,title,impactDescription,classification,status,service,feature,featureGroup,startDateTime,endDateTime,lastModifiedDateTime,isResolved,origin';

export function issueToCandidate(i: Record<string, unknown>, now: Date): Candidate | null {
  const id = str(i.id).trim();
  const title = str(i.title).trim();
  if (!id || !title) return null;
  const incident = same(i.classification, 'incident');
  const resolved = i.isResolved === true;
  const service = str(i.service).trim();
  const start = isoDate(i.startDateTime);
  const end = isoDate(i.endDateTime);
  const modified = isoDate(i.lastModifiedDateTime);
  const publishedAt = start ?? modified ?? now;
  return {
    externalId: id,
    title,
    summary: htmlToText(str(i.impactDescription)),
    url: SERVICE_HEALTH_LINK,
    kind: incident ? 'incident' : 'advisory',
    severity: incident ? 'high' : 'normal',
    status: resolved ? 'resolved' : 'active',
    publishedAt,
    updatedAt: modified && modified.getTime() !== publishedAt.getTime() ? modified : null,
    actionRequiredBy: null,
    services: service ? [service] : [],
    categories: [str(i.featureGroup), str(i.feature)].map((s) => s.trim()).filter(Boolean),
    tags: [],
    audience: [],
    facts: facts([
      ['Issue ID', id],
      ['Service', service],
      ['Feature', [str(i.featureGroup), str(i.feature)].filter(Boolean).join(' · ')],
      ['Classification', humanize(str(i.classification))],
      ['Status', humanize(str(i.status))],
      ['Started', day(start)],
      ['Ended', day(end)],
      ['Origin', humanize(str(i.origin))],
    ]),
  };
}

export const collectServiceHealth: Collector<ServiceHealth> = async (ctx, deps) => {
  const c = ctx.feed.collector;
  const now = deps.now();
  const { value, note } = await graphChangedSince(
    ctx,
    deps,
    { path: '/admin/serviceAnnouncement/issues', select: SELECT, maxItems: c.maxItems },
    since(ctx.state, c.lookbackDays, now),
  );
  return {
    candidates: value.map((i) => issueToCandidate(i, now)).filter((x): x is Candidate => x !== null),
    ...(note ? { note } : {}),
  };
};
