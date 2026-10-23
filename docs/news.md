# News and changes

**News and changes** (`/news`, in the Overview section of the navigation) collects the changes Microsoft announces for
the services AdminForge manages — Microsoft Entra, Exchange Online, Teams, SharePoint and OneDrive, Intune, Defender,
the Azure services AdminForge reports on (Azure Virtual Desktop among them), Microsoft Graph and the PowerShell modules
the runner pins — and, from each vendor's own feeds, the infrastructure and AI tooling around them: VMware vSphere and
ESXi, HPE servers and storage, DigiCert's certificate services, Anthropic's Claude and Claude Code, OpenRouter and n8n.
It shows them in a breaking-news style:

- a **Breaking** strip for what needs attention now (open incidents, urgent advisories, deadlines in the next two
  weeks);
- a day-by-day **feed** you can filter by area (Identity, Microsoft 365, Endpoint, Security, Azure, Infrastructure, AI
  and automation, Platform), kind,
  source, tag, text and time range;
- an **unread** count on the navigation item and a "N breaking" pill in the top bar.

Every item cites its source: the feed's name and publisher, and a link back to the original post. AdminForge keeps the
headline, a short plain-text excerpt (300 characters at most) and a few facts — never the article.

## Sources

Feeds are content: one `portal/content/feeds/<name>.feed.yaml` per source (schema: `portal/packages/schemas/src/news.ts`).
Only first-party sources are used — your tenant's own announcements, Microsoft's public feeds, and since 2026-10-23
each vendor's own official feed for the infrastructure, certificates and AI tooling around them (ADR-013 addendum):
never an aggregator, a news site or a scraped page.

| Feed                                                                                                                                                     | Publisher                                            | Scope  | How it's collected                                                                                                       | Every      | What's kept                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `feeds.m365-message-center`                                                                                                                              | Microsoft                                            | Tenant | Graph `GET /admin/serviceAnnouncement/messages` ([docs][mc-api]), automation identity                                    | 1 h        | Posts about managed services (Entra, Exchange, Teams, SharePoint, OneDrive, Intune, Defender, Microsoft 365 suite/admin center) |
| `feeds.m365-service-health`                                                                                                                              | Microsoft                                            | Tenant | Graph `GET /admin/serviceAnnouncement/issues` ([docs][sh-api])                                                           | 1 h        | Every incident and advisory (managed services get their area; others are Microsoft 365)                                         |
| `feeds.azure-service-health`                                                                                                                             | Microsoft                                            | Tenant | Azure Resource Graph `servicehealthresources` ([tables][arg-tables], [samples][arg-samples])                             | 1 h        | Every service issue, planned maintenance, health/security advisory and retirement for the readable subscriptions                |
| `feeds.azure-updates`                                                                                                                                    | Microsoft                                            | Public | Azure Updates RSS, linked from [Azure updates][azure-updates]                                                            | 1 h        | Launches, previews and retirements of managed Azure services                                                                    |
| `feeds.m365-roadmap`                                                                                                                                     | Microsoft                                            | Public | Microsoft 365 Roadmap RSS, linked from the [roadmap][roadmap]                                                            | 6 h        | In development / rolling out / launched features of managed services (cancelled ones dropped)                                   |
| `feeds.msrc-security`                                                                                                                                    | Microsoft Security Response Center                   | Public | Security Update Guide RSS ([update guide][msrc])                                                                         | 1 h        | CVEs in managed cloud services, PowerShell and Graph; on-premises look-alikes dropped                                           |
| `feeds.graph-changelog`                                                                                                                                  | Microsoft                                            | Public | Microsoft Graph [changelog][graph-changelog] RSS                                                                         | 24 h       | Every API change (flagged quiet when nothing new for 45 days)                                                                   |
| `feeds.entra-blog`, `intune-blog`, `exchange-blog`, `teams-blog`, `sharepoint-blog`, `azure-governance-blog`, `defender-xdr-blog`                        | Microsoft Tech Community                             | Public | The board's RSS feed on techcommunity.microsoft.com                                                                      | 3–6 h      | Every post (on-premises Exchange/SharePoint Server release posts dropped); excerpt only                                         |
| `feeds.learn-entra-whats-new`, `learn-intune-whats-new`, `learn-defender-xdr-whats-new`, `learn-graph-whats-new`, `learn-teams-powershell-release-notes` | Microsoft Learn                                      | Public | Learn search RSS, the subscription route [Learn documents][learn-rss], narrowed to the what's-new pages (`linkPrefixes`) | 24 h       | "This page was updated" with a link — Learn has no per-change feed                                                              |
| `feeds.powershell-modules`                                                                                                                               | Microsoft                                            | Public | PowerShell Gallery OData API ([supported repositories][psgallery])                                                       | 6 h        | New stable ExchangeOnlineManagement, MicrosoftTeams, Microsoft.Graph.Authentication, Az.Accounts versions                       |
| `feeds.avd-blog`, `feeds.learn-avd-whats-new`, `feeds.m365-blog`                                                                                         | Microsoft Tech Community / Microsoft Learn           | Public | The board's RSS feed; Learn search RSS narrowed to the AVD what's-new page                                               | 3 h / 24 h | Every post (azure: AVD, tag `avd`; m365), what's-new page updates                                                               |
| `feeds.microsoft-security-blog`                                                                                                                          | Microsoft                                            | Public | Microsoft Security Blog RSS                                                                                              | 3 h        | Every post (security; Entra posts also in identity; campaigns and zero-days as security)                                        |
| `feeds.vmware-cloud-foundation-blog`, `feeds.vmware-security-blog`                                                                                       | VMware by Broadcom                                   | Public | The blogs' RSS on blogs.vmware.com                                                                                       | 6 h        | Every post (infrastructure; ESXi, vSphere, vCenter tagged; end of support as retirement); excerpt only                          |
| `feeds.hpe-newsroom`                                                                                                                                     | Hewlett Packard Enterprise                           | Public | HPE newsroom RSS                                                                                                         | 6 h        | Only ProLiant, iLO, Synergy, OneView, Alletra, GreenLake, Private Cloud / VM Essentials and security posts (infrastructure)     |
| `feeds.digicert-status`                                                                                                                                  | DigiCert                                             | Public | Status page incident history RSS                                                                                         | 1 h        | Incidents and maintenance windows (security, tag `certificates`)                                                                |
| `feeds.anthropic-status`, `feeds.claude-code-releases`                                                                                                   | Anthropic                                            | Public | Claude status page history RSS; Claude Code releases (Atom) on its GitHub repository                                     | 1 h / 6 h  | Incidents and maintenance (ai); each Claude Code version as a release (ai, platform)                                            |
| `feeds.openrouter-blog`                                                                                                                                  | OpenRouter                                           | Public | OpenRouter blog RSS                                                                                                      | 6 h        | Platform announcements only (models and providers, routing, security, spend, pricing); tutorials and comparisons dropped (ai)   |
| `feeds.n8n-releases`, `feeds.n8n-blog`                                                                                                                   | n8n                                                  | Public | Releases (Atom) on n8n's GitHub repository; the n8n blog RSS                                                             | 6 h        | Each version once (the moving `stable`/`beta` tags dropped) as a release; every blog post (ai)                                  |
| `feeds.pnp-powershell`                                                                                                                                   | PnP community (Microsoft 365 Patterns and Practices) | Public | PowerShell Gallery OData API                                                                                             | 6 h        | New stable PnP.PowerShell versions — a community project, not Microsoft-supported                                               |

Deliberately not used: the old `azure.microsoft.com/…/updates/feed/` (gone), the MSRC blog feed (gone), third-party news
sites and aggregators. Not available (checked 2026-10-23, `docs/backlog.md`): VMware's security advisories (VMSA) —
Broadcom's support portal answers automated clients with a bot check; HPE's security bulletins — no public feed; the
OpenRouter status page — no feed; CISA's advisories — refused to automated clients; the HPE Developer blog — a 12.9 MB
feed, over the 8 MB cap. A module release is a prompt to read its notes and bump `portal/apps/runner/modules.lock.json`
deliberately — nothing updates on its own.

## How items are classified

Each feed's `classify` rules (see `FeedRule` in `news.ts`) place items in **areas** (the navigation sections, plus
`platform`, `infrastructure` and `ai`) and **tags** (`exchange`, `teams`, `intune`, `graph-api`, `key-vault`, …), and can set the **kind**, a
**severity** and a **status**:

- `match` lists values per field — `services` (the tenant sources' service names, PowerShell package ids) and
  `categories` (RSS categories, Message Center tags) match exactly; `title` and `text` match whole words or phrases (so
  "Exchange Online" never matches "Internet Key Exchange", "Microsoft Graph" never matches "Graphics"); all
  case-insensitive. A rule matches when any value matches any listed field.
- Rules run in order. Areas and tags add up; kind, severity and status come from the first rule that sets them
  (otherwise from the source itself — Message Center category and tags, health classification, the RSS categories);
  `exclude: true` drops the item.
- `keep: matched` keeps only items a rule placed in an area — the relevance filter for broad public feeds, which is
  how only changes to services AdminForge manages get in. `keep: all` keeps everything, with `defaultAreas`.

`tests/content/feeds-classify.test.ts` holds golden examples for the Microsoft and tenant feeds,
`tests/content/feeds-classify-vendors.test.ts` for the vendor feeds. A status page's items (Claude, DigiCert) are
incidents and maintenance: a rule reads Statuspage's latest update ("Resolved -", "Completed -") into `status:
resolved`, so a finished incident leaves Breaking at once instead of counting as open for 14 days.

**Kinds:** incident · advisory · maintenance · security · change · retirement · feature · preview · release · info.

## Breaking, unread and dates

Breaking is decided when the page is read, so it expires on its own:

- an incident that isn't resolved and was updated in the last 14 days (an incident whose resolution AdminForge never
  saw stops counting after two quiet weeks);
- a critical or high security item changed in the last 7 days;
- a critical or high advisory, change or retirement changed in the last 3 days;
- anything with an action-required date in the next 14 days (changed in the last 14 days);
- planned maintenance starting in the next 3 days.

**Unread** means changed since you last chose **Mark all as read** (your `newsSeenAt` preference); before you ever do,
the last 7 days count. The feed is ordered and grouped by the source's own date (last update, else publication). The
first collection of a feed doesn't flood everyone with "new": an item first seen is dated by the source, and only
later changes to it (title, summary, status, dates) count as new.

## Who sees what

- Everyone with **Portal.Reader** sees News and changes.
- Message Center posts marked as **Data privacy** (any tag or detail mentioning privacy) are shown only to **Portal.Admin** (in the Microsoft 365 admin
  center they are limited to Global Administrators and Message Center Privacy Readers; Graph doesn't document whether
  application reads return them — [Message center][mc-privacy]).
- A feed's `requires.portalRoles` applies to every item of that feed, checked when the page is read — restricting a feed
  hides what was already collected, and a reader without the roles doesn't see the feed among the sources either.
- Tenant feeds (Message Center, service health, Azure Service Health) are collected with the automation identity's
  application permissions but shown to every Portal.Reader: they are service announcements, not directory or mailbox
  data, and the point of the page is that engineers see them. This is a deliberate exception to the
  Operator-only default for scheduled data (SECURITY.md); give a feed `requires.portalRoles` to restrict it.
- A feed's error details (code and message) are shown to **Portal.Operator**; everyone else sees only its status.

## Collection and security

The hourly schedule `maintenance.news-refresh-hourly` (`cron: 5 * * * *`, UTC, `job: { kind: news }`) collects every
active feed — drafts and retired feeds are skipped, and a feed is skipped until its `pollMinutes` have passed (large
feeds without conditional requests are polled every few hours). Feeds run three at a time, the one longest without a
successful collection first, and no feed starts that couldn't finish inside the schedule's time limit (it reports
`out_of_time` and goes first next hour) — so one slow source can't starve the others.

- **Tenant feeds** run as the **automation identity** through the same outbound path as every other schedule (request
  policy, retries, provenance): Message Center needs the application permission **ServiceMessage.Read.All**, service
  health **ServiceHealth.Read.All** ([service communications API][sc-overview]); Azure Service Health needs
  **Reader** on the subscriptions. Security advisory details beyond title and summary need an elevated Azure role
  ([security advisories][azure-sec]) — AdminForge stays on Reader and says so on the item.
- **Public feeds** are fetched only over https from the hosts in `NEWS_FEED_HOSTS` (www.microsoft.com,
  api.msrc.microsoft.com, techcommunity.microsoft.com, www.powershellgallery.com, learn.microsoft.com,
  developer.microsoft.com; and each vendor's own: blogs.vmware.com, www.hpe.com, status.digicert.com,
  status.claude.com, openrouter.ai, blog.n8n.io, and github.com — where only the paths in `NEWS_FEED_PATHS` are read:
  the releases feeds of `anthropics/claude-code` and `n8n-io/n8n`, so another repository is a reviewed code change), only when the name resolves to public addresses — checked again when the connection is made,
  and the socket goes only to an address that passed (no DNS rebinding), with a 5-second DNS limit — following at most
  three redirects and only to those hosts, with a time limit and a size cap, conditional requests (ETag / If-Modified-Since) where the source
  supports them, and `User-Agent: AdminForge-News/1.0` (never the portal's address). Adding a host is a reviewed code
  change, not configuration or content.
- XML with a DOCTYPE or entity declarations is refused; text is reduced to plain text by a linear scanner over at most
  64 KiB per field (no HTML is ever rendered; control, bidi and invisible characters are removed); dates more than a day
  in the future are treated as the collection time.
- Citation links are kept only when they are https on an allowed domain (`NEWS_LINK_DOMAINS`: Microsoft's, and each
  listed vendor's), at most 2,048
  characters, without control or invisible characters — and, for public feeds, on the feed's own host or its homepage's
  host. Otherwise the feed's homepage is cited. A Microsoft host is not the same as Microsoft-authored text: Tech
  Community boards and the PowerShell Gallery carry posts and packages by others, which is why links must stay on the
  source's own site and every item names its publisher.
- In `DATA_MODE=fixtures` public feeds read `tests/fixtures/hosts/<host>/…` — never the internet.

## Terms of use (guidance, not legal advice)

Microsoft's public feeds and pages are offered under the [Microsoft Terms of Use][ms-tou] (personal, non-commercial and
informational use; don't modify or republish content; links don't imply endorsement), [Microsoft Learn's terms][learn-tou]
and the [PowerShell Gallery terms][psg-tou]; Graph and Azure Resource Graph data falls under the
[Microsoft APIs Terms of Use][apis-tou] (no copies of data beyond what the intended scenario needs, no more permissions
than needed). AdminForge stays inside them by design:

- it keeps the **unaltered headline**, a **short excerpt** (≤ 300 characters), the date, the source name and the
  **link back** — never full articles (Tech Community and changelog feeds carry whole posts; only the excerpt is kept);
- every item is labelled with its source and publisher; no Microsoft logos and nothing that suggests endorsement;
- it is an internal, informational tool for the organisation's own administrators;
- it polls politely (hourly at most, every few hours for large feeds, conditional requests where supported, an
  identifying User-Agent) and deletes items after `retentionDays`;
- tenant data stays inside the organisation and is read with read-only permissions.

The vendor feeds (VMware by Broadcom, HPE, DigiCert, Anthropic, OpenRouter, n8n, GitHub release feeds) are published for
subscription under each site's own terms of use; AdminForge treats them the same way — headline, short excerpt, date,
source and link back, labelled with the publisher, internal and informational, polled politely.

If AdminForge is ever offered to other organisations or commercially, have your legal team review these terms first.

## Operations

- **Run now:** an Operator can run the schedule from **Schedules → News and changes refresh → Run now**, or on the host:
  `node portal/apps/scheduler/dist/main.js --schedule maintenance.news-refresh-hourly` (prints one line per feed
  with its status and code — no tenant data). A feed collected less than `pollMinutes` ago reports `not_due`.
- **Feed status:** the **Sources** control on `/news` shows each feed's last successful collection, how often it is
  checked, and whether the source itself has gone quiet (`quietAfterDays`). A feed with no success for 3 hours (or
  twice its poll interval) is _stale_.
- **Retention:** items not seen in their source for `retentionDays` are deleted (unresolved incidents are kept while
  the source still lists them, up to 30 days after it last did); items the source still lists but the feed's rules no
  longer keep (a tightened rule) are removed on the next collection; items
  of a feed that no longer exists are deleted 30 days after they were last seen.
- **Permissions:** `pnpm adminforge provision entra` grants ServiceMessage.Read.All and ServiceHealth.Read.All to the
  automation app (they are declared by the tenant feeds; no opt-in is needed — they are service-announcement reads);
  `pnpm adminforge validate --scopes` checks them.

### Troubleshooting codes

| Code                        | What happened                                                                                                  | What to do                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `not_due`                   | Collected less than `pollMinutes` ago                                                                          | Nothing; it runs on a later hour                                                                                                       |
| `out_of_time`               | Not started: it couldn't have finished inside the schedule's time limit                                        | Nothing; it goes first on the next run. If it repeats, look for a feed that keeps timing out                                           |
| `feed_not_allowed`          | The URL (or a redirect) left the allow-list, isn't https, or resolves to a private address                     | Fix the URL in the feed; a new host needs a reviewed change to `NEWS_FEED_HOSTS`                                                       |
| `feed_failed`               | The source answered with an HTTP error                                                                         | Check the URL in a browser; Microsoft may have moved the feed                                                                          |
| `feed_unreachable`          | DNS or the connection failed, or the response stopped part-way                                                 | Check this host's outbound access to the source                                                                                        |
| `feed_timeout`              | The source didn't answer in time                                                                               | Usually transient; the next run retries                                                                                                |
| `feed_too_large`            | The response passed the size cap                                                                               | Narrow the feed (a filtered URL) or raise the cap in code after review                                                                 |
| `feed_unreadable`           | Not RSS/Atom, or it declared a DOCTYPE/entities                                                                | The URL now serves something else — find the source's current feed                                                                     |
| `feed_not_found`            | The source answered 200 with "Resource Not Found" (an unknown blog board)                                      | Fix the board id in the URL                                                                                                            |
| `feed_empty`                | No items after parsing and `linkPrefixes`                                                                      | The feed moved, or the Learn search no longer finds the page — check `linkPrefixes`; `allowEmpty: true` for feeds that are often empty |
| `upstream_forbidden`        | The automation identity lacks ServiceMessage.Read.All / ServiceHealth.Read.All, or Reader on the subscriptions | `pnpm adminforge provision entra`, then `provision status`; Azure: grant Reader on the subscriptions                                   |
| `automation_not_configured` | No automation identity is configured on this host                                                              | Set the automation app in the env file (`docs/operations.md`)                                                                          |

## Adding a feed

Use the `add-news-feed` skill (`.claude/skills/add-news-feed/SKILL.md`): `pnpm adminforge new feed feeds/<name>`
scaffolds a draft RSS feed with a fixture; first-party sources only; classification rules with `keep: matched` for
broad feeds; fixtures and golden classification tests; then set it active.

[mc-api]: https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-messages
[sh-api]: https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-issues
[sc-overview]: https://learn.microsoft.com/en-us/graph/api/resources/service-communications-api-overview
[mc-privacy]: https://learn.microsoft.com/en-us/microsoft-365/admin/manage/message-center
[arg-tables]: https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources
[arg-samples]: https://learn.microsoft.com/en-us/azure/service-health/resource-graph-samples
[azure-sec]: https://learn.microsoft.com/en-us/azure/service-health/security-advisories-elevated-access
[azure-updates]: https://azure.microsoft.com/updates
[roadmap]: https://www.microsoft.com/microsoft-365/roadmap
[msrc]: https://msrc.microsoft.com/update-guide
[graph-changelog]: https://developer.microsoft.com/graph/changelog
[learn-rss]: https://learn.microsoft.com/en-us/intune/fundamentals/use-docs
[psgallery]: https://learn.microsoft.com/en-us/powershell/gallery/powershellget/supported-repositories
[ms-tou]: https://www.microsoft.com/en-us/legal/terms-of-use
[learn-tou]: https://learn.microsoft.com/en-us/legal/termsofuse
[psg-tou]: https://www.powershellgallery.com/policies/Terms
[apis-tou]: https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use
