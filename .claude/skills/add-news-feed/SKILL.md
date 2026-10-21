---
name: add-news-feed
description: Use when asked to add, change or remove a source in News and changes (a Microsoft blog, roadmap, update or security feed, a Learn what's-new page, a PowerShell module's releases, Message Center or service health), or when news items land in the wrong area, show up when they shouldn't, or are missing.
---

# Adding a News and changes feed

## Overview

A feed is content: `portal/content/feeds/<name>.feed.yaml` (`kind: feed`, id `feeds.<name>`, schema
`portal/packages/schemas/src/news.ts`). The hourly schedule `maintenance.news-refresh-hourly` collects every active feed;
`/news` shows the items with a citation. **First-party sources only** — your tenant (Graph, Resource Graph) or
Microsoft's own public feeds. Read `docs/news.md` first.

## Steps

1. **Reuse first.** `rg -l "<product>" portal/content/feeds` — most changes are a new `classify` rule on an existing
   feed (e.g. a newly managed Azure service → add its product category to `feeds.azure-updates`).
2. **Find the official feed and verify it live** (`curl -sS -A 'AdminForge-News/1.0' -o <scratch>/feed.xml -w '%{http_code} %{redirect_url}'`):
   RSS 2.0 or Atom, 200 without redirects off-host, and note ETag/Last-Modified support and size. Prefer the source
   Microsoft documents (e.g. Learn search RSS for what's-new pages: `https://learn.microsoft.com/api/search/rss?search=<"quoted title">&locale=en-us`
   - `linkPrefixes` for the page). Never a third-party aggregator, scraper or unofficial mirror.
3. **Host allow-list.** The URL's host must be in `NEWS_FEED_HOSTS` (`news.ts`). Adding a host is a **code change for
   security review** (SECURITY.md) — never a configuration or content workaround. Citation links must be on
   `NEWS_LINK_DOMAINS`.
4. **Scaffold:** `pnpm adminforge new feed feeds/<name>` → a draft RSS feed + a fixture stub. Fill in `title`,
   `summary` (say plainly what the source is), `publisher` (who publishes it — a community project is not "Microsoft"),
   `homepage` (the human page), `collector`.
5. **Relevance and classification.** Broad feeds use `keep: matched` with rules that set `areas` only for services
   AdminForge manages (derive them from `portal/content`); narrow feeds use `keep: all` + `defaultAreas`. `services` /
   `categories` match exactly; `title` / `text` match whole words or phrases — add `exclude: true` rules for look-alikes
   (on-premises "Exchange Server", "Internet Key Exchange", "Graphics"). Set `kind`/`status` from the source's status
   categories. Don't set severity high on public feeds unless the source says so — Breaking must stay meaningful.
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
    deployment, after publishing: `node portal/apps/scheduler/dist/main.js --schedule …` in the pod), then check the
    feed's status on `/news` (counts only in anything you paste).

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
