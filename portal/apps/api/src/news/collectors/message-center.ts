import type { FeedCollector, NewsKind, NewsSeverity, PortalRole } from '@adminforge/schemas';
import { htmlToText } from '../text';
import type { Candidate } from '../types';
import {
  day,
  facts,
  graphChangedSince,
  humanize,
  isoDate,
  since,
  str,
  strings,
  type Collector,
} from './shared';

/**
 * Microsoft 365 Message Center (Graph GET /admin/serviceAnnouncement/messages, application permission
 * ServiceMessage.Read.All), as the automation identity, messages modified since the last run.
 */

type MessageCenter = Extract<FeedCollector, { kind: 'messageCenter' }>;

const CATEGORY_KIND: Record<string, NewsKind> = {
  planForChange: 'change',
  preventOrFixIssue: 'advisory',
  stayInformed: 'info',
};
const CATEGORY_LABEL: Record<string, string> = {
  planForChange: 'Plan for change',
  preventOrFixIssue: 'Prevent or fix issue',
  stayInformed: 'Stay informed',
};

/** The Microsoft 365 admin center's link for one message (survives the sign-in redirect). */
export const messageCenterLink = (id: string) =>
  `https://admin.cloud.microsoft/?ref=MessageCenter/:/messages/${encodeURIComponent(id)}`;

const has = (tags: string[], tag: string) => tags.some((t) => t.toLowerCase() === tag.toLowerCase());

export function messageToCandidate(m: Record<string, unknown>, now: Date): Candidate | null {
  const id = str(m.id).trim();
  const title = str(m.title).trim();
  if (!id || !title) return null;
  const tags = strings(m.tags);
  const services = strings(m.services);
  // Graph enum values may come camelCase or PascalCase.
  const category =
    Object.keys(CATEGORY_KIND).find((k) => k.toLowerCase() === str(m.category).toLowerCase()) ??
    str(m.category);
  let kind: NewsKind = CATEGORY_KIND[category] ?? 'info';
  if (has(tags, 'Retirement')) kind = 'retirement';
  else if (has(tags, 'New feature')) kind = 'feature';
  const sev = str(m.severity).toLowerCase();
  const severity: NewsSeverity = sev === 'critical' ? 'critical' : sev === 'high' ? 'high' : 'normal';
  const start = isoDate(m.startDateTime);
  const modified = isoDate(m.lastModifiedDateTime);
  const publishedAt = start ?? modified ?? now;
  const updatedAt = modified && modified.getTime() !== publishedAt.getTime() ? modified : null;
  const actBy = isoDate(m.actionRequiredByDateTime);
  const major = m.isMajorChange === true;
  const details = Array.isArray(m.details) ? (m.details as Array<Record<string, unknown>>) : [];
  const detail = (name: string) =>
    details.find((d) => str(d.name).toLowerCase() === name.toLowerCase())?.value as string | undefined;
  const body = (m.body ?? {}) as Record<string, unknown>;
  // Data privacy posts are for Global Administrators and Message Center Privacy Readers in the admin center; Graph
  // doesn't document how app-only reads mark them, so any privacy marker (a tag mentioning privacy, a detail named for
  // it or set to "Data privacy") keeps the post for Portal.Admin.
  const privacy =
    tags.some((t) => /privacy/i.test(t)) ||
    details.some((d) => /privacy/i.test(str(d.name)) || /^\s*data privacy\s*$/i.test(str(d.value)));
  const audience: PortalRole[] = privacy ? ['Portal.Admin'] : [];
  return {
    externalId: id,
    title,
    summary: htmlToText(str(body.content)),
    url: messageCenterLink(id),
    kind,
    severity,
    status: null,
    publishedAt,
    updatedAt,
    actionRequiredBy: actBy,
    services,
    categories: tags,
    tags: major ? ['major-change'] : [],
    audience,
    facts: facts([
      ['Message ID', id],
      ['Category', CATEGORY_LABEL[category] ?? humanize(category)],
      ['Services', services.join(', ')],
      ['Tags', tags.join(', ')],
      ['Major change', major ? 'Yes' : null],
      ['Act by', day(actBy)],
      ['Roadmap ID', typeof detail('RoadmapIds') === 'string' ? detail('RoadmapIds') : null],
      ['Platforms', typeof detail('Platforms') === 'string' ? detail('Platforms') : null],
    ]),
  };
}

export const collectMessageCenter: Collector<MessageCenter> = async (ctx, deps) => {
  const c = ctx.feed.collector;
  const now = deps.now();
  const { value, note } = await graphChangedSince(
    ctx,
    deps,
    { path: '/admin/serviceAnnouncement/messages', maxItems: c.maxItems },
    since(ctx.state, c.lookbackDays, now),
  );
  return {
    candidates: value.map((m) => messageToCandidate(m, now)).filter((x): x is Candidate => x !== null),
    ...(note ? { note } : {}),
  };
};
