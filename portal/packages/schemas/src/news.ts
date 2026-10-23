import { z } from 'zod';
import { DefinitionId, envelopeShape } from './common';

/**
 * News and changes (feeds): first-party sources that announce changes to what the engineers run — Microsoft's own,
 * and since 2026-10-23 (owner, ADR-013 addendum) each vendor's own official feed for the infrastructure, certificates
 * and AI tooling around it (VMware by Broadcom, HPE, DigiCert, Anthropic, OpenRouter, n8n). Never an aggregator.
 *
 * A feed is content (`portal/content/feeds/<name>.feed.yaml`). The scheduler's `news` job (hourly) collects every active
 * feed — tenant feeds as the automation identity (Microsoft Graph, Azure Resource Graph), public feeds over https from an
 * allow-listed first-party host — classifies each item into AdminForge areas, keeps a short plain-text excerpt and a
 * citation link, and the News and changes page (/news) shows them. Nothing is republished in full: every item links
 * back to its source.
 */

/**
 * AdminForge areas: the navigation sections, plus `platform` (Microsoft Graph and the PowerShell modules AdminForge
 * uses), `infrastructure` (VMware vSphere and ESXi, HPE servers and storage) and `ai` (Anthropic, OpenRouter, n8n: the AI
 * and automation tooling engineers build on).
 */
export const NEWS_AREAS = [
  'identity',
  'm365',
  'endpoint',
  'security',
  'azure',
  'infrastructure',
  'ai',
  'platform',
] as const;
export const NewsArea = z.enum(NEWS_AREAS);
export type NewsArea = z.infer<typeof NewsArea>;

/**
 * What an item is.
 * incident (service issue) · advisory (service advisory / prevent-or-fix) · maintenance (planned) · security (security
 * advisory, CVE) · change (plan for change, behaviour change) · retirement (deprecation, end of support) · feature (new or
 * generally available) · preview · release (module or API release) · info (stay informed).
 */
export const NEWS_KINDS = [
  'incident',
  'advisory',
  'maintenance',
  'security',
  'change',
  'retirement',
  'feature',
  'preview',
  'release',
  'info',
] as const;
export const NewsKind = z.enum(NEWS_KINDS);
export type NewsKind = z.infer<typeof NewsKind>;

export const NEWS_SEVERITIES = ['critical', 'high', 'normal', 'low'] as const;
export const NewsSeverity = z.enum(NEWS_SEVERITIES);
export type NewsSeverity = z.infer<typeof NewsSeverity>;

/**
 * Hosts public feeds may be fetched from: https only, public addresses only, and redirects are followed only to another
 * host on this list. Adding a host is a reviewed code change (SECURITY.md), never configuration or content.
 */
export const NEWS_FEED_HOSTS = [
  'www.microsoft.com',
  'api.msrc.microsoft.com',
  'techcommunity.microsoft.com',
  'www.powershellgallery.com',
  'learn.microsoft.com',
  'developer.microsoft.com',
  // Each vendor's own feeds (ADR-013 addendum, 2026-10-23): status pages, blogs, release feeds.
  'blogs.vmware.com',
  'www.hpe.com',
  'status.digicert.com',
  'status.claude.com',
  'openrouter.ai',
  'blog.n8n.io',
  // Anyone can publish on GitHub: only the paths in NEWS_FEED_PATHS (a vendor's own repository's releases).
  'github.com',
] as const;

/**
 * Hosts where anyone can publish: a feed (and every redirect) must be one of these exact paths, so which repository is
 * read is a reviewed code change too, not content alone (ADR-013 addendum).
 */
export const NEWS_FEED_PATHS: Readonly<Record<string, RegExp>> = {
  'github.com': /^\/(?:anthropics\/claude-code|n8n-io\/n8n)\/releases\.atom$/,
};

/**
 * Citation links an item may carry: https on one of these domains (or a sub-domain). Anything else is dropped and the
 * feed's `homepage` is cited instead.
 */
export const NEWS_LINK_DOMAINS = [
  'microsoft.com',
  'azure.com',
  'cloud.microsoft',
  'office.com',
  'microsoft365.com',
  'powershellgallery.com',
] as const;

/**
 * Vendors' citation hosts, exactly (ADR-013 addendum): their other sub-domains carry community posts and gists. A vendor
 * feed's links must also be on the feed's own host or its homepage's (collectors), and GitHub feeds narrow them to the
 * repository's release pages (`linkPrefixes`).
 */
export const NEWS_LINK_HOSTS = [
  'blogs.vmware.com',
  'www.hpe.com',
  'status.digicert.com',
  'status.claude.com',
  'openrouter.ai',
  'blog.n8n.io',
  'github.com',
] as const;

/** True when `raw` is an https URL on an allowed citation domain or vendor host (no credentials, default port). */
export function isCitationUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return (
    (NEWS_LINK_HOSTS as readonly string[]).includes(host) ||
    NEWS_LINK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
  );
}

/** True when `raw` is an https URL on an allow-listed feed host (no credentials, default port). */
export function isFeedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (!(NEWS_FEED_HOSTS as readonly string[]).includes(host)) return false;
  const only = NEWS_FEED_PATHS[host];
  return !only || (only.test(url.pathname) && !url.search);
}

const FeedUrl = z.string().refine(isFeedUrl, {
  message: `Expected an https URL on an allowed feed host (${NEWS_FEED_HOSTS.join(', ')})`,
});
const CitationUrl = z.string().refine(isCitationUrl, {
  message: `Expected an https URL on an allowed citation domain (${[...NEWS_LINK_DOMAINS, ...NEWS_LINK_HOSTS].join(', ')})`,
});

/** Service tag shown as a chip (exchange, teams, intune, graph-api, …). */
export const NewsTag = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use a lower-case kebab tag, e.g. exchange or graph-api')
  .max(32);

/** PowerShell Gallery package id. */
const PackageId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'Expected a PowerShell Gallery package id');

/**
 * How a feed is collected.
 * - messageCenter: Microsoft 365 Message Center (Graph /admin/serviceAnnouncement/messages, ServiceMessage.Read.All).
 * - serviceHealth: Microsoft 365 service health issues (Graph /admin/serviceAnnouncement/issues, ServiceHealth.Read.All).
 * - azureServiceHealth: Azure Service Health events of the subscriptions the automation identity can read (Resource Graph
 *   `servicehealthresources`, Reader).
 * - rss: a public RSS 2.0 or Atom feed on an allow-listed host.
 * - psGallery: new versions of PowerShell Gallery packages (the modules AdminForge's runner loads).
 */
export const FeedCollector = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('messageCenter'),
    /** First run (and the oldest change kept on later runs): messages modified in the last N days. */
    lookbackDays: z.number().int().min(1).max(365).default(60),
    maxItems: z.number().int().min(1).max(2000).default(1000),
  }),
  z.strictObject({
    kind: z.literal('serviceHealth'),
    lookbackDays: z.number().int().min(1).max(30).default(14),
    maxItems: z.number().int().min(1).max(2000).default(500),
  }),
  z.strictObject({
    kind: z.literal('azureServiceHealth'),
    lookbackDays: z.number().int().min(1).max(90).default(30),
    /** Event types to keep (default: all four). */
    eventTypes: z
      .array(z.enum(['ServiceIssue', 'PlannedMaintenance', 'HealthAdvisory', 'SecurityAdvisory']))
      .min(1)
      .optional(),
    maxItems: z.number().int().min(1).max(2000).default(500),
  }),
  z.strictObject({
    kind: z.literal('rss'),
    url: FeedUrl,
    /** Items whose last update is older than this are not kept. */
    lookbackDays: z.number().int().min(1).max(365).default(90),
    /** Newest items (by last update) kept per collection. */
    maxItems: z.number().int().min(1).max(1000).default(300),
    /** Keep only items whose link starts with one of these (e.g. one Learn page out of a search feed). */
    linkPrefixes: z.array(CitationUrl).min(1).optional(),
    /** A feed with no items is reported as an error (a moved or retired feed often answers 200 and empty) unless true. */
    allowEmpty: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal('psGallery'),
    packages: z.array(PackageId).min(1).max(20),
    /** Include prerelease versions (default false). */
    prerelease: z.boolean().default(false),
    /** Versions kept per package. */
    versions: z.number().int().min(1).max(20).default(5),
  }),
]);
export type FeedCollector = z.infer<typeof FeedCollector>;

export const TENANT_COLLECTORS = ['messageCenter', 'serviceHealth', 'azureServiceHealth'] as const;
export const isTenantCollector = (kind: FeedCollector['kind']) =>
  (TENANT_COLLECTORS as readonly string[]).includes(kind);

const MatchValues = z.array(z.string().min(1).max(120)).min(1);

/**
 * One classification rule. `match` lists values per field; the rule matches when **any** value matches **any** listed
 * field (case-insensitive):
 * - services: the service names a tenant source reports (Message Center `services`, the health issue's `service`, Azure
 *   impacted services) and, for psGallery, the package id — exact match.
 * - categories: the feed item's categories (RSS `<category>`, Atom `<category term>`, Message Center tags) — exact match.
 * - title / text: whole-word (or phrase) match in the title, or in title + excerpt.
 *
 * Rules run in order. Areas and tags add up over every matching rule; `kind` and `severity` come from the first matching
 * rule that sets them (otherwise the collector's own mapping); a matching `exclude: true` rule drops the item.
 */
export const FeedRule = z
  .strictObject({
    match: z
      .strictObject({
        services: MatchValues.optional(),
        categories: MatchValues.optional(),
        title: MatchValues.optional(),
        text: MatchValues.optional(),
      })
      .refine((m) => Object.values(m).some((v) => v !== undefined), {
        message: 'Give at least one field to match',
      }),
    areas: z.array(NewsArea).min(1).optional(),
    tags: z.array(NewsTag).optional(),
    kind: NewsKind.optional(),
    severity: NewsSeverity.optional(),
    /** Status shown on the item (e.g. Rolling out, Launched, In preview); first matching rule wins. */
    status: z.string().min(1).max(40).optional(),
    exclude: z.literal(true).optional(),
  })
  .refine((r) => r.exclude || r.areas || r.tags || r.kind || r.severity || r.status, {
    message: 'A rule needs areas, tags, kind, severity, status or exclude: true',
  });
export type FeedRule = z.infer<typeof FeedRule>;

export const Feed = z
  .strictObject({
    kind: z.literal('feed'),
    ...envelopeShape,
    /** Who publishes the source, cited on every item ("Microsoft", "Microsoft Security Response Center"). */
    publisher: z.string().min(1).max(80),
    /** The source's home page: cited when an item has no link of its own, and on the sources list. */
    homepage: CitationUrl,
    collector: FeedCollector,
    /** Classification into AdminForge areas and service tags (see FeedRule). */
    classify: z.array(FeedRule).default([]),
    /**
     * `matched` keeps only items a rule placed in at least one area — the relevance filter for broad public feeds (only
     * changes to services AdminForge manages). `all` keeps everything; unplaced items get `defaultAreas`.
     */
    keep: z.enum(['matched', 'all']).default('all'),
    defaultAreas: z.array(NewsArea).default([]),
    /**
     * Minimum minutes between collections (default 60). The hourly job skips a feed collected more recently — large
     * feeds without conditional requests (the roadmap, module releases) are polled every few hours.
     */
    pollMinutes: z.number().int().min(60).max(1440).default(60),
    /** Flag the feed as quiet when its newest item is older than this (a feed Microsoft stopped updating). */
    quietAfterDays: z.number().int().min(1).max(365).optional(),
    /** Items not seen in the source for this long are deleted (active incidents are kept). */
    retentionDays: z.number().int().min(7).max(730).default(180),
    /** Plain-text excerpt kept per item: a short quote with a link back, never the article. */
    excerptChars: z.number().int().min(80).max(500).default(300),
  })
  .superRefine((def, ctx) => {
    if (def.keep === 'matched' && !def.classify.some((r) => r.areas?.length))
      ctx.addIssue({
        code: 'custom',
        path: ['classify'],
        message: 'keep: matched needs at least one rule with areas (otherwise nothing is kept)',
      });
    if (def.keep === 'all' && !def.defaultAreas.length)
      ctx.addIssue({
        code: 'custom',
        path: ['defaultAreas'],
        message: 'keep: all needs defaultAreas for items no rule places',
      });
    // Tenant feeds run as the automation identity: Graph feeds declare their application permissions (provisioning
    // grants them and `validate --scopes` checks them); the Azure feed declares the Azure role it needs on subscriptions.
    if (def.collector.kind === 'azureServiceHealth') {
      if (!def.requires?.azureRoles?.length)
        ctx.addIssue({
          code: 'custom',
          path: ['requires', 'azureRoles'],
          message:
            'The Azure Service Health feed reads Resource Graph as the automation identity: declare requires.azureRoles (Reader)',
        });
    } else if (isTenantCollector(def.collector.kind) && !def.requires?.scopes?.graph?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['requires', 'scopes'],
        message:
          'Tenant feeds run as the automation identity: declare the application permissions in requires.scopes.graph',
      });
  });
export type Feed = z.infer<typeof Feed>;

/** Schedule job: refresh every active feed (or `refs`). */
export const NewsJob = z.strictObject({
  kind: z.literal('news'),
  refs: z.array(DefinitionId).min(1).optional(),
  /** Feeds collected at the same time (default 3). */
  concurrency: z.number().int().min(1).max(8).optional(),
});
export type NewsJob = z.infer<typeof NewsJob>;

// ── API (GET /api/news, /api/news/summary, /api/news/:id) ──────────────────────────────────────────────────────────

export const NewsFact = z.object({ label: z.string(), value: z.string() });

export const NewsItemDto = z.object({
  id: z.string(),
  /** Feed definition key, e.g. feeds.azure-updates. */
  feed: z.string(),
  feedTitle: z.string(),
  publisher: z.string(),
  /** The source's own id: MC123456, EX123456, a tracking id, an RSS guid, Package@1.2.3. */
  externalId: z.string(),
  title: z.string(),
  /** Plain text (never HTML). */
  summary: z.string(),
  /** Citation link (https, an allowed domain or vendor host: NEWS_LINK_DOMAINS, NEWS_LINK_HOSTS). */
  url: z.string(),
  kind: NewsKind,
  severity: NewsSeverity,
  areas: z.array(NewsArea),
  tags: z.array(z.string()),
  /** Source status where there is one: active / resolved (incidents), rolling out, launched, … */
  status: z.string().nullable(),
  publishedAt: z.string(),
  /** When the source last changed the item. */
  updatedAt: z.string().nullable(),
  /** When AdminForge first saw it, and when its content last changed (drives "new" and "updated"). */
  firstSeenAt: z.string(),
  changedAt: z.string(),
  actionRequiredBy: z.string().nullable(),
  breaking: z.boolean(),
  /** Changed since the person's newsSeenAt. */
  unread: z.boolean(),
  facts: z.array(NewsFact),
});
export type NewsItemDto = z.infer<typeof NewsItemDto>;

export const NewsListQuery = z.object({
  area: NewsArea.optional(),
  kind: NewsKind.optional(),
  feed: DefinitionId.optional(),
  tag: NewsTag.optional(),
  q: z.string().trim().max(200).optional(),
  /** Changed in the last N days (default 30). */
  days: z.coerce.number().int().min(1).max(730).default(30),
  breaking: z.enum(['true', 'false']).optional(),
  unread: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type NewsListQuery = z.infer<typeof NewsListQuery>;

export const NewsListResponse = z.object({
  items: z.array(NewsItemDto),
  nextCursor: z.string().nullable(),
});
export type NewsListResponse = z.infer<typeof NewsListResponse>;

export const NewsFeedStatus = z.object({
  key: z.string(),
  title: z.string(),
  publisher: z.string(),
  homepage: z.string(),
  scope: z.enum(['tenant', 'public']),
  /** ok · error (last run failed) · stale (no success for 3 hours) · never (not collected yet). */
  status: z.enum(['ok', 'error', 'stale', 'never']),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  pollMinutes: z.number().int(),
  /** Newest item's activity date, and whether that is older than the feed's quietAfterDays. */
  newestAt: z.string().nullable(),
  quiet: z.boolean(),
  /** Items currently kept for this feed (that the caller may see). */
  items: z.number().int(),
  /** Only for Portal.Operator; null otherwise or when the last run succeeded. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type NewsFeedStatus = z.infer<typeof NewsFeedStatus>;

export const NewsSummaryResponse = z.object({
  /** Items changed since newsSeenAt (the last 7 days when it was never set), capped at 99. */
  unread: z.number().int(),
  breakingUnread: z.number().int(),
  /** Up to 5 breaking items, newest first. */
  breaking: z.array(NewsItemDto),
  /** Newest successful collection over all feeds. */
  lastUpdatedAt: z.string().nullable(),
  seenAt: z.string().nullable(),
  feeds: z.array(NewsFeedStatus),
});
export type NewsSummaryResponse = z.infer<typeof NewsSummaryResponse>;
