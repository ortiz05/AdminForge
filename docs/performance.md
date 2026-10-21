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
  in-process) whose Graph is the fake in separate processes, 120 ms Graph round trip (±30%), a think time between
  page loads (±50%) and a ramp over which people start; each page load asks for the datasources the browser would.
  The output lists per page the latency, largest response and the datasources asked for, datasource errors by page
  with an example message, and event-loop stalls over 250 ms with when they happened.

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

**Design target: about 50 engineers using AdminForge at the same time.** One API process with the defaults (48 slots
per Microsoft service, lanes), the 100k-user tenant, 120 ms Graph round trip. Each engineer opens a page, reads it and
opens the next after a think time (±50%); people start over about one think time (`--ramp`). The default mix is lists
and entity pages (~80% of page loads), the Microsoft 365, security and identity health dashboards and the
privileged-roles and inactive-guests reports. Like the browser, each page load asks only for the datasources its
shown blocks use (an entity page's first tab).

| Engineers                 | Think | Page loads/s | p50    | p95   | p99   | Lists p50 / p95 | Entity pages p50 / p95 | Refused | Event loop p99 / max | Peak RSS |
| ------------------------- | ----- | ------------ | ------ | ----- | ----- | --------------- | ---------------------- | ------- | -------------------- | -------- |
| **50**                    | 30 s  | 1.5          | 0.15 s | 1.4 s | 23 s  | 0.14 / 0.32 s   | 0.14 / 0.32 s          | 0       | 31 / 261 ms          | 1.1 GB   |
| **50**                    | 15 s  | 2.9          | 0.14 s | 1.5 s | 24 s  | 0.13 / 0.29 s   | 0.14 / 0.29 s          | 0       | 37 / 407 ms          | 1.3 GB   |
| **50**, everyone clicking | 4 s   | 9.7          | 0.15 s | 4.1 s | 27 s  | 0.09 / 0.69 s   | 0.16 / 1.2 s           | 0       | 84 / 458 ms          | 1.5 GB   |
| 100 (headroom)            | 15 s  | 5.9          | 0.15 s | 3.6 s | 26 s  | 0.14 / 0.44 s   | 0.15 / 0.55 s          | 0       | 64 / 488 ms          | 1.4 GB   |
| 200 (headroom)            | 15 s  | 11           | 0.18 s | 4.2 s | 33 s  | 0.17 / 0.80 s   | 0.18 / 0.88 s          | 0       | 151 / 575 ms         | 1.5 GB   |
| 200, everyone clicking    | 4 s   | 19           | 0.32 s | 16 s  | 145 s | 0.24 / 2.1 s    | 0.36 / 1.6 s           | 0       | 190 / 771 ms         | 2.1 GB   |

Lists: users, groups, devices, sign-ins, audit logs, enterprise apps, licences, privileged roles. Entity pages: a
user, a group, a device. RSS includes about 0.6 GB for the test's own copy of the synthetic tenant (it picks ids
from it). No page load failed in any run.

What this shows:

- **At the design target nothing waits on anything.** Lists and entity pages answer in about 0.15 s (p95 ≤ 0.3 s at
  15–30 s think, ≤ 1.2 s when all 50 click every few seconds), nothing is refused, the event loop stays below 40 ms
  at p99 (84 ms in the burst) and the process at 1.1–1.5 GB. Graph sees 9–16 calls a second (53 in the burst) — far
  below one app's directory budget.
- **The p95/p99 are two crawls, not load.** The identity health dashboard (~4 s) and the inactive-guests report
  (~23 s) read whole collections at 100k users; one engineer alone waits as long. They are content work (counts at
  the source, snapshots — below), not sizing.
- **Headroom is about 4×.** 200 engineers at 15 s think: still nothing refused, lists p95 0.8 s. 200 all clicking
  every 4 s still refuses nothing, but lists reach 2 s at p95 and the crawls queue behind each other (inactive guests
  145 s at p99).
- **Datasource errors**: the Defender for Cloud tile (Azure Resource Graph, not modelled by the fake) — and, rarely,
  a transform that ran out of its 250 ms wall-clock budget while a large crawl's garbage collection or response
  reading held the event loop for 250–600 ms: 0, 1 and 3 datasources at 50 engineers (of 1,300–4,300), up to 8 of
  8,400 at 200. These runs predate the API running a timed-out transform once more before failing, which should absorb most of them. Counting only a transform's own
  time is in the [backlog](backlog.md).

#### Beyond the design target (not acted on)

Runs from the same day with every engineer asking for every datasource of a page (heavier than the browser: the
inactive-guests report sent 14 MB instead of 1.8 MB):

| Engineers | Think | Slots | Page loads/s | p50    | p95   | Refused | Users list p50 | Event loop p99 | Peak RSS |
| --------- | ----- | ----- | ------------ | ------ | ----- | ------- | -------------- | -------------- | -------- |
| 1,000     | 15 s  | 48    | 18           | 15.6 s | 120 s | 25%     | 15.2 s         | 80 ms          | 2.6 GB   |
| 1,000     | 15 s  | 160   | 22           | 6.0 s  | 120 s | 0       | 4.6 s          | 336 ms         | 3.4 GB   |
| 2,000     | 45 s  | 48    | 19           | 15.6 s | 120 s | 33%     | 15.2 s         | 55 ms          | 2.3 GB   |
| 2,000     | 45 s  | 160   | 21           | 5.2 s  | 120 s | 0       | 3.6 s          | 320 ms         | 3.2 GB   |
| 5,000     | 45 s  | 48    | 53           | 15.2 s | 33 s  | 62%     | 15.1 s         | 101 ms         | 2.5 GB   |

What limits it: one process with 48 slots makes 65–90 Graph calls a second of this mix against the fake (≈ 20 page
loads a second; more with lighter pages). Asked for more, the first call of a datasource waits the whole `OUTBOUND_QUEUE_WAIT_MS` (15 s)
for a slot — so p50 sits at 15 s — and the rest is refused `outbound_busy`. 160 slots removed the refusals at 1,000
and 2,000 engineers, but the crawling dashboards then ran into the 120 s deadline and the event loop p99 rose to
~330 ms. All processes share the Read app's Graph budget (directory reads ≈ 400–800 calls a second, sign-in and audit
reports 5 requests per 10 s), so beyond that, fewer calls per page (snapshots, counts at the source) is what scales.

#### Earlier runs: the lanes change (4 s think, every datasource)

One API process, 4 s think time, 60 s run (+ drain). "Light": lists and entity pages only.

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

## Sizing guide

**Design target: about 50 engineers at the same time.** One API process with the defaults serves them with lists and
entity pages in about 0.15 s (p95 ≤ 0.3 s at a realistic 15–30 s between page loads, ≤ 1.2 s if all 50 click every
few seconds), nothing refused and the event loop under 40 ms at p99 — with about 4× headroom (200 engineers at 15 s:
nothing refused, lists p95 0.8 s). Measured above; dashboards and reports that crawl whole collections are slow at
100k users regardless of load until their content is reworked.

- **Count people clicking, not accounts.** Engineers who are signed in but reading cost nothing; a page load every
  15–30 s per active engineer is a busy morning.
- **Memory**: plan 2 GB for the API process (1.1–1.5 GB measured at 50–200 engineers, 2.1 GB in the 200-person
  burst, including large crawls and the per-process cache, 256 MB by default).
- **If usage grows**, watch three things and change one thing at a time:
  - **`outbound_busy` refusals or slow lists** (people waiting for a slot): raise `OUTBOUND_CONCURRENCY` [48] — 160
    removed every refusal at 1,000–2,000 engineers — while the `microsoft call` log lines show no `throttled` /
    `throttledRetries`. The Read app's Graph budget is shared by every process, so slots × processes is what
    Microsoft sees.
  - **A busy event loop** (`eventLoopDelay` p99 above ~250 ms, transform timeouts, the API process near one full
    core): the API is one process by design (it owns the SQLite file and is also the run worker and the scheduler,
    ADR-016), so more processes are not an option — find the heavy transform or dashboard (the `microsoft call` lines
    and the datasource timings name it) and move the work to the source (filters, counts, snapshots).
  - **Heavy dashboards opened by many people** (the same crawl for every engineer): tenant-wide snapshots and counts
    at the source ([backlog](backlog.md)) — more slots or processes don't make a crawl of 100k objects faster.
- **Re-measure** with `pnpm test:perf` after content changes and `tests/perf/load.ts` (`--sessions`, `--think`,
  `--ramp`) before a large roll-out.
