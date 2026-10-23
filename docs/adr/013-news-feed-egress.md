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

Adding a publisher is a reviewed code change, not a content or configuration change (`add-news-feed` skill) — on a
host anyone can publish on (GitHub), down to the exact feed path (`NEWS_FEED_PATHS`). Microsoft
blogs and Learn pages outside the list can't be added by content alone. See `docs/news.md` and SECURITY.md.

## Addendum (2026-10-23): each vendor's own feeds

The owner widened "first-party" from Microsoft only to **each vendor's own official feed** for what the engineers run
around Microsoft 365 and Azure: VMware by Broadcom (`blogs.vmware.com`: the Cloud Foundation and security blogs —
vSphere, ESXi), HPE (`www.hpe.com` newsroom, kept only for servers, storage, private cloud and security), DigiCert
(`status.digicert.com`), Anthropic (`status.claude.com`; Claude Code releases on `github.com/anthropics/claude-code`),
OpenRouter (`openrouter.ai` blog) and n8n (`blog.n8n.io`; releases on `github.com/n8n-io/n8n`). Each host is on
`NEWS_FEED_HOSTS` and, exactly, on `NEWS_LINK_HOSTS` (no sub-domains: community forums and gists live there);
everything above still applies (https, pinned public addresses, redirects only between listed hosts, caps, plain text,
citations on the feed's own host). On `github.com`, where anyone publishes, only the paths in `NEWS_FEED_PATHS` are
read — the two vendors' releases feeds — checked for the first request and every redirect, and the feeds cite only
their repository's release pages (`linkPrefixes`). News
gains two areas, `infrastructure` and `ai`. Still never an aggregator, a news site or a scraped page; sources without
a readable feed (VMware security advisories behind Broadcom's bot check, HPE security bulletins, OpenRouter's status
page) are recorded in `docs/news.md` instead.
