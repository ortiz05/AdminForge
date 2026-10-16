# News and changes — implementation plan

**Goal:** a "News and changes" section that shows, in a breaking-news style, the changes Microsoft announces to the
services AdminForge manages (Entra ID, Exchange Online, Teams, SharePoint/OneDrive, Intune, Defender, Azure, Microsoft
Graph, the runner's PowerShell modules). Every item cites a first-party source. An hourly schedule keeps it current.

**Architecture:** feeds are content (`kind: feed`, `portal/content/feeds/*.feed.yaml`, schema
`portal/packages/schemas/src/news.ts`). The scheduler's new `news` job (`job.kind: news`, hourly schedule
`portal/content/schedules/maintenance/news-refresh-hourly.schedule.yaml`) collects every active feed, classifies items
into AdminForge areas, stores them in Postgres (`news_items`, `news_feed_state`), and publishes a `news.updated` event.
The API serves `/api/news*` (session + Portal.Reader); the web app shows `/news` with a breaking strip, filters, a
day-grouped feed with citations, and an unread badge in the navigation.

## Contract (already in the tree — do not change without telling the other agents)

- `portal/packages/schemas/src/news.ts`: `NEWS_AREAS`, `NEWS_KINDS`, `NEWS_SEVERITIES`, `NEWS_FEED_HOSTS`,
  `NEWS_LINK_DOMAINS`, `isFeedUrl`, `isCitationUrl`, `FeedCollector`, `FeedRule`, `Feed`, `NewsJob`, and the API
  types `NewsItemDto`, `NewsListQuery`, `NewsListResponse`, `NewsFeedStatus`, `NewsSummaryResponse`.
- `kind: 'feed'` is registered in `KINDS`, `DEFINITION_SCHEMAS` and `Definition`; `NewsJob` is in `ScheduleJob`.
- `UserPrefs.newsSeenAt` (ISO date-time) — the "mark all as read" marker.
- `portal/apps/api/src/schedules/jobs.ts` has a placeholder `case 'news'` (501) for the backend to replace.

## Sources (first-party only)

| Feed key                     | Collector            | What                                                                 |
| ---------------------------- | -------------------- | -------------------------------------------------------------------- |
| `feeds.m365-message-center`  | `messageCenter`      | Tenant Message Center (Graph, ServiceMessage.Read.All, app-only)      |
| `feeds.m365-service-health`  | `serviceHealth`      | Tenant M365 incidents/advisories (Graph, ServiceHealth.Read.All)      |
| `feeds.azure-service-health` | `azureServiceHealth` | Azure Service Health events (Resource Graph `servicehealthresources`) |
| `feeds.azure-updates`        | `rss`                | Azure Updates (public RSS)                                            |
| `feeds.m365-roadmap`         | `rss`                | Microsoft 365 Roadmap (public RSS)                                    |
| `feeds.graph-changelog`      | `rss`                | Microsoft Graph changelog (public RSS)                                |
| `feeds.msrc-security`        | `rss`                | MSRC security updates (public RSS), filtered to managed services      |
| `feeds.powershell-modules`   | `psGallery`          | ExchangeOnlineManagement, MicrosoftTeams, PnP.PowerShell releases     |

Exact URLs come from the source research (verified live). Public feeds keep only a headline, a short plain-text excerpt
and a link back (Microsoft's terms for RSS/website content); the UI never renders source HTML.

## Normalised item and storage

`news_items`: id uuid pk · feed_key · external_id (unique per feed) · title · summary (plain text, ≤ excerptChars) ·
url (citation) · kind · severity · areas text[] · tags text[] · status · audience text[] (portal roles required, all of
them) · published_at · updated_at · action_required_by · first_seen_at · last_seen_at · changed_at (content hash
changed) · content_hash · facts jsonb (≤ 12 label/value pairs).

`news_feed_state`: feed_key pk · last_run_at · last_success_at · status · error_code · error_message · etag ·
last_modified · items · new_items · updated_items · duration_ms.

**Ordering and dates:** `activity_at = coalesce(updated_at, published_at)` (the source's own last activity) orders the
feed, groups it by day and drives the `days` filter. **Unread** = `changed_at > prefs.newsSeenAt` (the last 7 days when it
was never set). On first insert `changed_at = least(now, activity_at)`, so the first collection doesn't make every
historic item "new"; later content changes (hash differs) set `changed_at = now`. **Breaking** (computed at read time, so
it expires on its own):

- `incident` whose status is not resolved, changed in the last 14 days;
- `security` with severity critical/high, changed in the last 7 days;
- `advisory`/`change`/`retirement` with severity critical/high, changed in the last 3 days;
- anything with `actionRequiredBy` within the next 14 days (and not past), changed in the last 14 days;
- `maintenance` starting within the next 3 days (actionRequiredBy holds the start).

**Audience:** a feed's `requires.portalRoles` applies to every item; Message Center items tagged "Data privacy" need
Portal.Admin. Feed error details are shown to Portal.Operator only.

## Collection rules (security)

- Tenant feeds go through `ctx.outbound` as `{ kind: 'automation', mode: 'read' }` (request policy, provenance, retries).
- Public feeds: https only; host must be in `NEWS_FEED_HOSTS`; resolves to public addresses only (reuse
  `isNonPublicAddress`); redirects followed manually, at most 3, only to `NEWS_FEED_HOSTS`; 20 s timeout; 5 MB cap;
  conditional GET (ETag / If-Modified-Since); `User-Agent: AdminForge-News/1.0` (never the portal URL).
- XML: reject any document containing `<!DOCTYPE` or `<!ENTITY`; no external resolution; only the five XML entities and
  numeric character references are decoded.
- Text: HTML → plain text (tags stripped, entities decoded, whitespace collapsed, control characters removed), cut at
  `excerptChars` on a word boundary with "…". Links: kept only when `isCitationUrl`, else the feed's homepage.
- In `DATA_MODE=fixtures` public feeds read `tests/fixtures/hosts/<host>/…` through `createFixtureFetch` — never the
  internet.

## Work split (parallel agents)

1. **Backend** — `portal/apps/api/src/news/**`, DB schema + migration, the `news` job, retention, events, API routes
   `portal/apps/api/src/routes/news.ts` (+ registration in `app.ts`), `newsSeenAt` in the not-audited prefs set, fixtures,
   unit/api tests.
2. **UI** — `/news` route and page, navigation badge, top-bar breaking indicator, icons, component tests, e2e (mock).
3. **Content, provisioning and docs** — feed YAML library from the verified sources, hourly schedule, navigation item,
   CLI (`new feed`, validate, `--scopes` as automation), provisioning picks up the feeds' app permissions, docs, skill,
   CHANGELOG.
4. **Security review** of the finished feature (product only).
