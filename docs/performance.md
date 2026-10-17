# Performance at enterprise scale

How AdminForge's page loads hold up for a large enterprise, how that is measured, and how to size a host. The tools
are in [tests/perf/](../tests/perf/README.md); the limits they exercise are described in
[operations.md → Sizing for a large tenant](operations.md#sizing-for-a-large-tenant).

## How it is measured

- **A synthetic enterprise tenant** (`tests/perf/tenant/generate.ts`, deterministic): 100,000 users (8% guests, 55%
  synced, licences direct and through groups, managers, signInActivity from today to never), 50,000 groups (a
  100,000-member All Company group, nested, dynamic, Microsoft 365 with ~5,000 teams, ownerless, empty), 30,000 Intune
  devices and 36,000 Entra devices, 20,000 app registrations and service principals with credentials, 1 million
  sign-ins and 100,000 directory audit events a day for 30 days (computed on demand), usage report rows per user, site
  and team, Intune policies and apps, role assignments and PIM. Names include apostrophes, non-Latin scripts and very
  long values.
- **A fake Microsoft Graph** over that tenant (`tests/perf/graph/`) that behaves like Graph where it changes cost or
  correctness — paging and its caps, `ConsistencyLevel: eventual` for `$count`/`$search`/advanced queries, 20 expanded
  members, `$batch`, log scans that answer short pages — and refuses what it doesn't model.
- **Every datasource** of every page, dashboard and report runs through the real engine against it, one at a time
  (`pnpm test:perf`). ≈ live = requests × 250 ms (a typical Graph round trip, pages are sequential) + transform time.
  Budgets in `tests/perf/budgets.json` fail the suite when a datasource gets slower or bigger, or new content doesn't
  meet the default.
- **A load test** (`tests/perf/load.ts`): N signed-in engineers loading pages through the real API (Fastify,
  in-process) whose Graph is the fake in separate processes, 120 ms Graph round trip (±30%), 4 s think time.

Azure (ARM, Resource Graph, Log Analytics) and the PowerShell runner are not modelled: their datasources show as
`unmodelled` and need a separate check.

## Results (2026-10-17)

Host: 48 × Xeon E5-2697 v4, 96 GB, Node 24; other work was running on the host (load average 6–12), and the engine
was being changed in parallel (the per-session rate limit, `OUTBOUND_QUEUE_WAIT_MS` and `DATASOURCE_DEADLINE_MS` were
already in), so treat the numbers as an order of magnitude.

### Datasources at 100k users

326 datasources: 180 run within the default budget (≤ 25 requests, ≤ 10 MB, transform ≤ 250 ms, ≤ 8 s live), 32 are
skipped by their `when`, 75 read Azure or the runner (not modelled), and **39 fail at this scale** — almost all because
their transform runs out of its 250 ms budget after the whole collection was fetched. The suite runs in ~3.5 minutes.

| Datasource                                | Requests | MB   | ≈ live | Result at 100k users                                            |
| ----------------------------------------- | -------- | ---- | ------ | --------------------------------------------------------------- |
| `identity.inactive-users#users`           | 766      | 58.3 | 192 s  | transform out of budget (every member, 120 per page)            |
| `m365.licence#users`                      | 355      | 30.2 | 89 s   | transform out of budget (every holder of the SKU, 120 per page) |
| `identity.app-registrations#apps`         | 200      | 24.5 | 50 s   | transform out of budget (`$top 100` with `$expand=owners`)      |
| `identity.password-policies#users`        | 92       | 32.6 | 23 s   | transform out of budget                                         |
| `identity.health#stale`                   | 89       | 3.6  | 23 s   | transform out of budget (crawl for two KPIs)                    |
| `identity.inactive-guests#guests`         | 68       | 5.6  | 17 s   | transform out of budget                                         |
| `identity.consent-grants#grants`          | 51       | 13.0 | 13 s   | ok (50,000 rows, untransformed)                                 |
| `m365.teams#teams`                        | 49       | 3.2  | 12 s   | transform out of budget                                         |
| `m365.teams-without-owners#teams`         | 49       | 2.9  | 12 s   | ok, transform 192 ms (close to the budget)                      |
| `m365.overview#teams`                     | 49       | 3.2  | 12 s   | ok (crawls every team for three KPIs)                           |
| `m365.onedrive-usage#accounts`            | 43       | 31.7 | 11 s   | transform out of budget                                         |
| `m365.inactive-licensed-users#users`      | 43       | 53.3 | 11 s   | transform out of budget                                         |
| `m365.mailbox-storage#mailboxes`          | 43       | 43.4 | 11 s   | transform out of budget                                         |
| `endpoint.autopilot-not-enrolled#devices` | 42       | 8.2  | 11 s   | transform out of budget                                         |
| `identity.directory-changes#audits`       | 21       | 15.0 | 6 s    | transform out of budget, and **truncated** at 20,000 events     |

Also failing at this scale: the endpoint device reports (os-versions, device-security-gaps, stale-devices), apps,
the usage-report pages (SharePoint sites, anyone links), the app credential reports and dashboard tile, users without
MFA, disabled users with licences and risky-user detections (expression nested too deeply). The Conditional Access
report-only impact report counts every sign-in through Log Analytics, or samples the newest 300 from Graph. Lists and entity pages (users, groups, devices, sign-ins,
audit logs, enterprise apps) are cursor-paged, filter at the source and stay fast. The full table is
`tests/perf/out/datasources.md` after a run; `budgets.json` lists every known-slow datasource with its reason.

### Many engineers at once

One API process, 120 ms Graph round trip, 4 s think time, 60 s run (+ drain). "Default mix": lists, entity pages, a
few dashboards and reports; "light": lists and entity pages only. Every engineer clicks every few seconds — 1,000 such
sessions is a heavy morning for a company several times that size.

**Before** (one pool of 16 slots per service, a slot held for a whole call, every page of a crawl included):

| Run                                               | Page loads/s | p50    | p95    | p99    | Refused `outbound_busy` | Event loop p99 |
| ------------------------------------------------- | ------------ | ------ | ------ | ------ | ----------------------- | -------------- |
| 200 sessions, default mix                         | 5.8          | 9.8 s  | 85 s   | 118 s  | 0                       | 262 ms         |
| 1,000 sessions, default mix                       | 26           | 15.1 s | 31.7 s | 56 s   | 65% of datasources      | 258 ms         |
| 1,000 sessions, default mix, one address (NAT)    | 21           | 15.2 s | 31.4 s | 59 s   | 58%                     | 258 ms         |
| 1,000 sessions, light                             | 32           | 15.1 s | 30.9 s | 31.6 s | 60%                     | 51 ms          |
| 1,000 sessions, light, `OUTBOUND_CONCURRENCY=64`¹ | 49           | 11.2 s | 23.7 s | 24.2 s | 0                       | 242 ms         |

**After** (lanes: slots per attempt, list pages, entity reads, batches and the first two pages of a crawl served first,
crawls limited to half the slots, schedules apart; 16 fake Graph processes so the fake isn't the bottleneck):

| Run                                     | Slots | Page loads/s | p50    | p95    | Users list p50 | Entity page p50 | Refused `outbound_busy` | Event loop p99 |
| --------------------------------------- | ----- | ------------ | ------ | ------ | -------------- | --------------- | ----------------------- | -------------- |
| 200 sessions, default mix               | 16    | 7.5          | 6.1 s  | 62 s   | 3.9 s          | 10.5 s          | 0                       | 83 ms          |
| 200 sessions, default mix               | 32    | 11.3         | 2.9 s  | 51 s   | 1.8 s          | 5.9 s           | 0                       | 261 ms         |
| **200 sessions, default mix (default)** | 48    | 13.3         | 2.1 s  | 49 s   | 1.3 s          | 3.8 s           | 0                       | 273 ms         |
| 200 sessions, default mix               | 64    | 17.2         | 1.2 s  | 29 s   | 0.85 s         | 2.6 s           | 0                       | 286 ms         |
| 1,000 sessions, default mix             | 48    | 22.1         | 15.2 s | 73 s   | 15.0 s         | 30.8 s          | 25%                     | 276 ms         |
| 1,000 sessions, default mix             | 64    | 20.3         | 15.3 s | 81 s   | 15.0 s         | 30.5 s          | 22%                     | 289 ms         |
| 1,000 sessions, light¹                  | 64    | 49.2         | 11.2 s | 22.6 s | 11.0 s         | 22.2 s          | 0                       | 240 ms         |

¹ Smaller log-scan budget in the fake (`--scan-budget 10000`), as in the "before" row it compares with.

What this shows:

- **Lanes keep the clicking fast.** At 200 sessions nothing is refused any more, and the users list went from 4.6 s
  (before, 16 slots) to 3.9 s with the same 16 slots and 1.3 s with the new default of 48. A dashboard that crawls a
  collection no longer holds every slot: it waits in its lane (the KPI dashboards that crawl whole collections still
  take 35–60 s — a content problem, below).
- **A 1,000-session storm is a Graph-volume problem, not a slot problem.** Every engineer clicking every 4 s asks for
  roughly 250 page loads a second — about 2,000 Graph calls a second. One process does 200–320 calls a second at 48–64
  slots and refuses the rest (`outbound_busy` after 15 s); more processes would only run into Microsoft's own budget
  for one app in one tenant (directory reads: 8,000 resource units per 10 s, about 400–800 calls a second). What scales
  past that is fewer calls: snapshots and shared results (below).
- **The event loop stays responsive** (p99 ≤ 290 ms) and memory at 1.5–2.7 GB RSS.
- **The per-person cache barely helps** (2–4% hit rate): every engineer has their own cache entries.
- **The rate limit is per session**, so a NAT address doesn't lock people out (no 429s in the NAT run).

## What would fix it (in order of effect)

1. **Content for big collections filters and counts at the source**, never "fetch everything, then transform": KPIs
   from `$count` (with `ConsistencyLevel: eventual`) or `*Counts` reports, lists cursor-paged with server-side
   `$filter`/`$search`/`$orderby`, untransformed rows for exports. The 39 failing datasources above, starting with the
   reports that read every user at 120 per page.
2. **Tenant-wide snapshots for the heavy reports** (inactive users, credentials, device posture, usage): computed on a
   schedule by the automation identity and read by pages with an "as of" time, instead of every engineer re-crawling.
3. ~~**Keep heavy and light work apart**~~ — done: lanes (operations.md → Sizing). Still open: transforms off the
   event loop.
4. **Size the slots to Microsoft's limits**, not the CPU: Graph throttles per tenant and app (48 by default), so raise
   `OUTBOUND_CONCURRENCY` while watching `throttled` / `throttledRetries` in the `microsoft call` log lines.

## Sizing guide (draft)

For engineers who load a page every few seconds while they work, one API process with the defaults (48 Graph slots,
lanes) gives list pages in about a second and entity pages in a few seconds to roughly **200 engineers actively
clicking at the same moment**;
dashboards and reports that crawl whole collections are slow at enterprise scale regardless of load until their
content is reworked (above). Rules of thumb:

- **Active engineers, not accounts.** 2,000 people with access rarely means more than 100–200 clicking at once.
- **Slots per process**: the default 48 for up to ~200 active engineers; 64 measured better still and fits a large
  tenant while Graph doesn't throttle (see operations.md). Above that, more API processes behind the proxy only help
  until Microsoft's per-app, per-tenant budget is reached (all processes share it) — beyond it, fewer calls per page
  (snapshots, counts at the source) is what scales.
- **Memory**: plan 2–4 GB for the API process at enterprise scale (large crawls and the per-process cache, 256 MB by
  default).
- **Re-measure** with `pnpm test:perf` after content changes and `tests/perf/load.ts` before a large roll-out.
