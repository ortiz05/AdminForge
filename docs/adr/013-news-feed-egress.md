# ADR-013: News and changes fetch public feeds from an allow-list kept in code

Status: accepted (2026-10-15)

## Context

News and changes is the first feature that reads the public internet instead of Microsoft's APIs with a token. Feed
definitions are content, and content must not be able to point AdminForge at arbitrary hosts (SSRF, data exfiltration,
or untrusted text presented as Microsoft guidance). Alternatives considered: a host list in configuration (an operator
could widen it without review), per-feed hosts in content (any publisher could add a host), and a third-party
aggregation service (a new data path and dependency).

## Decision

Public feeds are fetched only from `NEWS_FEED_HOSTS` in `portal/packages/schemas/src/news.ts`, over https, with the
connection pinned to the public address that was checked, manual redirects (at most 3) to allow-listed hosts only, and
time and size caps (`portal/apps/api/src/news/fetch-feed.ts`). Item links must be on `NEWS_LINK_DOMAINS`. Feeds are
plain text (HTML stripped), collected by the scheduler as the automation identity, and tenant feeds (Message Center,
service health) use Microsoft Graph and ARM like any other read.

## Consequences

Adding a publisher is a reviewed code change, not a content or configuration change (`add-news-feed` skill). Microsoft
blogs and Learn pages outside the list can't be added by content alone. See `docs/news.md` and SECURITY.md.
