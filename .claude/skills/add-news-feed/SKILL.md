---
name: add-news-feed
description: Use when asked to add, change or remove a source in News and changes (a Microsoft blog, roadmap, update or security feed, a Learn what's-new page, a PowerShell module's releases, Message Center or service health, or a vendor's own status page, blog or release feed — VMware, HPE, DigiCert, Anthropic, OpenRouter, n8n), or when news items land in the wrong area, show up when they shouldn't, or are missing.
---

# Adding a News and changes feed

## Overview

A feed is content: `portal/content/feeds/<name>.feed.yaml` (`kind: feed`, id `feeds.<name>`, schema
`portal/packages/schemas/src/news.ts`). The hourly schedule `maintenance.news-refresh-hourly` collects every active feed;
`/news` shows the items with a citation. **First-party sources only** — your tenant (Graph, Resource Graph),
Microsoft's own public feeds, or a vendor's own official feed (its status page, blog or the release feed of its own
repository; ADR-013 addendum). Read `docs/news.md` first.

## When not to use

- Your tenant's own state on a page (service health, Message Center as a list) → `adding-a-page-or-report`.
- A check that should alert when something breaks → `adding-a-schedule-or-probe`.
- A news site, aggregator, community blog or scraped HTML page — never: the publisher's own RSS/Atom or Microsoft's
  documented API only. A source on a host outside `NEWS_FEED_HOSTS` needs a security-reviewed code change first (step 3).
- A new schedule for feeds — `maintenance.news-refresh-hourly` already collects every active feed.

## Steps

1. **Reuse first.** `pnpm adminforge list --kind feed --search "<product>"` (full text:
   `rg -l "<product>" portal/content/feeds`) — most changes are a new `classify` rule on an existing
   feed (e.g. a newly managed Azure service → add its product category to `feeds.azure-updates`).
2. **Find the official feed and verify it live** (`curl -sS -A 'AdminForge-News/1.0' -o <scratch>/feed.xml -w '%{http_code} %{redirect_url}'`):
   RSS 2.0 or Atom, 200 without redirects off-host, and note ETag/Last-Modified support and size. Prefer the source
   Microsoft documents (e.g. Learn search RSS for what's-new pages, with `linkPrefixes` for the page:
   `https://learn.microsoft.com/api/search/rss?search=<"quoted title">&locale=en-us`). Never a third-party
   aggregator, scraper or unofficial mirror.
3. **Host allow-list.** The URL's host must be in `NEWS_FEED_HOSTS` (`news.ts`). Adding a host is a **code change for
   security review** (SECURITY.md) — never a configuration or content workaround. Citation links must be on
   `NEWS_LINK_DOMAINS` (Microsoft, with sub-domains) or exactly on `NEWS_LINK_HOSTS` (vendors). On a host anyone can
   publish on (GitHub), the exact feed path goes in `NEWS_FEED_PATHS` (also a reviewed code change: check the
   repository is the vendor's own verified organisation) and the feed narrows `linkPrefixes` to its release pages.
4. **Scaffold:** `pnpm adminforge new feed feeds/<name>` → a draft RSS feed + a fixture stub. Fill in `title`,
   `summary` (say plainly what the source is), `publisher` (who publishes it — a community project is not "Microsoft"),
   `homepage` (the human page), `collector`.
5. **Relevance and classification.** Broad feeds use `keep: matched` with rules that set `areas` only for services
   AdminForge manages (derive them from `portal/content`); narrow feeds use `keep: all` + `defaultAreas`. `services` /
   `categories` match exactly; `title` / `text` match whole words or phrases — add `exclude: true` rules for look-alikes
   (on-premises "Exchange Server", "Internet Key Exchange", "Graphics"). Set `kind`/`status` from the source's status
   categories. A `kind: incident` stays in Breaking for 14 days unless its `status` is `resolved`: on a status page,
   add a rule that reads the final update into `status: resolved` (`feeds.anthropic-status`). Don't set severity high on public feeds unless the source says so — Breaking must stay meaningful.
6. **Politeness:** `pollMinutes` 60 for small or conditional (ETag) feeds, 180–360 for large feeds without conditional
   requests, 1440 for page-updated signals. Keep `excerptChars` ≤ 300 (headline + short excerpt + link, never the
   article).
7. **Tenant feeds** (`messageCenter`, `serviceHealth`, `azureServiceHealth`) declare `requires.scopes.graph`
   (application permissions; provisioning grants them) or `requires.azureRoles: [Reader]`. Data-privacy Message Center
   posts are Portal.Admin only — don't widen that.
8. **Fixtures:** a synthetic `tests/fixtures/hosts/<host>/<path>/GET[__<query>].json` (`fixtureKey()` in
   `portal/packages/connectors/src/fixtures.ts` names it; `$fixture` with `headers` and a string `body`). Synthetic text
   only (Example Org) — never copy Microsoft's content into the repo.
9. **Tests:** add the feed id to `tests/content/feeds.test.ts` (it asserts the exact set) and golden items to
   `tests/content/feeds-classify.test.ts` — at least one kept and one dropped look-alike.
10. **Validate:** `pnpm adminforge validate`, `pnpm --filter @adminforge/tests exec vitest run --project content content/feeds`,
    `pnpm guard`; update the sources table in `docs/news.md`. Then remove `status: draft`.
11. **Try it once live:** against your dev database,
    `pnpm --filter @adminforge/scheduler exec tsx src/main.ts --schedule maintenance.news-refresh-hourly` (in a
    deployment, after publishing, a code owner runs the same flags in the pod — `portal/apps/scheduler/README.md`),
    then check the feed's status on `/news` (counts only in anything you paste).

12. **Removing a source:** retire the feed (`status: retired`, version bump, a `Retired — …` summary;
    `docs/content-recipes.md` › Versions, previews and retiring) — the file stays, so its id stays in the exact set in
    `tests/content/feeds.test.ts` and its fixture stays; say in `docs/news.md` that it is retired.

## Done when

- [ ] The feed answered 200 live without an off-host redirect, from a host in `NEWS_FEED_HOSTS`
- [ ] `pnpm adminforge validate` and the content project's feed tests are clean; `feeds.test.ts` lists the id and
      `feeds-classify.test.ts` has a kept item and a dropped look-alike
- [ ] The fixture is synthetic (Example Org), `status: draft` is gone and `docs/news.md` lists the source
- [ ] One live collection showed the feed's status on `/news` (counts only in anything you paste)

## Common mistakes

| Mistake                                                    | Fix                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A news site, aggregator or scraped HTML page               | First-party RSS/Atom or Microsoft's documented API only                                |
| Adding a host to the allow-list to make validation pass    | It's a security-reviewed code change; find the source's feed on an allowed host first  |
| `keep: all` on a broad feed (roadmap, Azure Updates, MSRC) | `keep: matched` with area rules for managed services                                   |
| `text: [Exchange]`                                         | Phrases: `Exchange Online`; exclude `Exchange Server`, `Internet Key Exchange`         |
| Copying real posts into fixtures                           | Synthetic Example Org items                                                            |
| Raising `excerptChars` to show "the whole thing"           | Link back; the excerpt is a quote, not a copy                                          |
| Polling a 2 MB feed with no ETag every hour                | `pollMinutes: 360`                                                                     |
| A Learn search feed without `linkPrefixes`                 | Search results include Q&A posts and unrelated pages; keep only the what's-new page(s) |

## See also

- `docs/news.md` (sources, classification, politeness), `portal/packages/schemas/src/news.ts` (`NEWS_FEED_HOSTS`,
  `NEWS_LINK_DOMAINS`), ADR-013 (news feed egress)
- `docs/content-recipes.md` › Fixtures and › Versions, previews and retiring; `adding-a-schedule-or-probe`
