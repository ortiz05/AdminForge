# Enterprise scenarios

The situations a large organisation puts AdminForge in, what AdminForge must do in each, and what checks it. "Synthetic"
means the synthetic enterprise tenant and fake Microsoft Graph (`pnpm test:perf`, `docs/performance.md`); "live" means
the validation tenant (`tests/live`, `docs/plans/2026-10-17-enterprise-scale-schedules-and-coverage.md` Phase G);
"unit" / "content" / "api" / "e2e" are the vitest projects and Playwright. A scenario without a check yet is marked
**gap** and listed in `docs/backlog.md`.

Use it when you add a page, report or playbook: find the scenarios your data can hit and make sure each has a check.

## Scale

| Scenario                                       | AdminForge must                                                                                                                                                             | Check                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 100k users, 50k groups, 30k devices            | List pages page through the server (cursor), filter and search at the source, count with `$count`; no page reads a whole collection to show a KPI                           | Synthetic: every datasource within its budget (`tests/perf/budgets`)             |
| A group with 100k members (all-company)        | Member lists page; member counts come from `/members/$count`; nothing expands members inline                                                                                | Synthetic                                                                        |
| 1M sign-ins a day                              | Sign-in pages default to a bounded window and filter at the source; an entity page never asks for an unbounded user history                                                 | Synthetic; content (window defaults)                                             |
| A collection larger than `maxItems`            | The page says it shows the first N (`truncated`), never presents a cut list as complete                                                                                     | Unit (outbound truncation); synthetic                                            |
| 2,000 engineers signed in, 200 loading at once | Identical concurrent reads are coalesced per user; queues have a wait limit and answer "busy, try again" instead of hanging; rate limits are per person, not per office NAT | Load test (`tests/perf/load.ts`); unit (coalescing, queue limit, rate-limit key) |
| A 100k-row transform                           | Never on the request thread past its budget: heavy aggregates are summaries at the source, reports stream untransformed rows                                                | Synthetic; content (`azure-report-library` rule, budgets)                        |
| Export of 100k rows                            | Streams pages to the file; capped by `EXPORT_MAX_ROWS` with the cap named in the file                                                                                       | API (export)                                                                     |

## Throttling and Microsoft-side failures

| Scenario                                                                      | AdminForge must                                                                                                                          | Check                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Graph answers 429 with `Retry-After`                                          | Waits as told (capped), without holding a concurrency slot while it waits, retries a bounded number of times, logs that it was throttled | Unit (http); synthetic (429 injection) |
| A request that times out                                                      | Retries at most once, then a clear error with a reference; sign-in and audit logs get one longer attempt                                 | Unit                                   |
| The engineer leaves the page mid-load                                         | The crawl stops (abort signal), freeing Microsoft quota                                                                                  | Unit                                   |
| One datasource of a page fails                                                | The rest of the page renders; the failed widget says what happened and what to do                                                        | Component; e2e                         |
| Microsoft returns a page that disagrees with the count (eventual consistency) | Shows what was returned; counts labelled as approximate where Microsoft says so                                                          | Synthetic **gap**                      |
| A Microsoft service is down (service health incident)                         | Pages fail with "Microsoft service unavailable", probes alert once, schedules retry then report                                          | Unit (errors); probes                  |

## Identity and access

| Scenario                                           | AdminForge must                                                                                                      | Check                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| An engineer without the directory role a tab needs | That tab says which role is missing (403 hint); the rest of the page works                                           | API (error hints); live (validation user without service roles) |
| A guest or B2B user in a list                      | Shown as a guest, home tenant visible where Graph gives it; guest-only filters work                                  | Synthetic; live (Phase F guests)                                |
| A synced (hybrid) account                          | Read-only attributes are marked as managed on-premises; playbooks that would change them refuse with that reason     | Content (playbook preflight); synthetic **gap** for lists       |
| A deleted user, group or app                       | Not in normal lists; available in "recently deleted" views; links to it say it was deleted                           | Content; live **gap**                                           |
| Licences assigned through a group                  | Shown with their source group; "remove licence" playbooks don't try to remove a group-assigned licence directly      | Content; live (Phase F licence group)                           |
| Licence assignment errors                          | Listed per user with the error and the source group                                                                  | Content (`identity.licence-assignment-errors`)                  |
| Conditional Access claims challenge / CAE          | One automatic sign-in at most, then a "Sign in again" banner — never a loop                                          | Unit (sign-in guard); e2e (`inspector-sign-in-loop`)            |
| Sign-in frequency policy on the portal app         | The session ends when Entra says; user schedules ask their owner to sign in again (ADR-014)                          | API; live **gap**                                               |
| PIM: role eligible but not active                  | The PIM indicator says so and links to activate; writes needing it refuse with "activate X in PIM"                   | Component; live (Phase 1 PIM fixture)                           |
| Break-glass accounts                               | Never changed by a playbook (`AF_PROTECTED_USER_IDS`); excluded from the example Conditional Access policies         | Unit (protected ids); content                                   |
| An engineer leaves the company                     | Their portal schedules stop (`creator_access_removed`); their delegated user schedules are deleted with their tokens | API (creator access); ADR-014 tests                             |

## Data quality

| Scenario                                                                       | AdminForge must                                                                                                               | Check                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Names with apostrophes (O'Brien), quotes, `&`, `#`, `%`                        | Filters and searches escape them (`$odata()`, `$odataSearch()`, `$kql()`, `$encode()`); nothing breaks or widens a query      | Unit (expressions); synthetic (tricky names) |
| Non-Latin names (Ελένη, 王伟, محمد), right-to-left text, emoji                 | Displayed and sorted correctly; search finds them                                                                             | Synthetic; e2e (rendering) **gap**           |
| Very long values (256-character display names, 1,000-character descriptions)   | Truncated with the full value on hover / in the inspector; layout holds at phone width                                        | e2e screenshots                              |
| Missing values (no department, no manager, no usage location, never signed in) | Shown as "—" or "Never", counted in completeness reports, never as errors                                                     | Content; synthetic                           |
| A user who has never signed in                                                 | "Never", included in inactive-user reports with their creation date                                                           | Content                                      |
| Usage reports with concealed names                                             | Detected (no `@` in the UPN) and explained, never shown as broken data                                                        | Content                                      |
| Time zones and daylight saving                                                 | Times shown in the engineer's zone with the zone named; schedules run at the wall-clock time in their zone across DST changes | Unit (cadence describer, DST); API (preview) |

## Tenant shapes

| Scenario                                               | AdminForge must                                                                                                                            | Check                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| A brand-new tenant (no data yet, licences just bought) | Empty states explain when data arrives (Secure Score 48 h, usage reports 24–72 h, registration details 24–48 h) instead of reading as zero | Content (empty states)                        |
| A licence the tenant doesn't have                      | The feature shows what it needs (`requires.licences`), no failed calls                                                                     | Content; live (licence gates)                 |
| No Azure subscription configured                       | Azure pages and probes say "not configured" instead of failing                                                                             | Content; live                                 |
| Multi-geo / several verified domains                   | Domain-based checks cover every email-enabled domain, not only the primary                                                                 | Content (`m365.email-authentication`) **gap** |
| Several Microsoft 365 SKUs and trials                  | Seat probes cover the tenant's own SKUs; renewal dates and trials are reported                                                             | Content (`m365.subscription-renewals`)        |

## Writes and automation

| Scenario                                         | AdminForge must                                                                                                   | Check                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A write playbook on 1,000 selected rows          | Bulk runs are capped, each row's result recorded, a partial failure reported per row                              | Unit (engine bulk)                                   |
| Two engineers changing the same object           | The later write sees the current state (preflight reads), conflicts are reported, nothing is silently overwritten | Content (playbook preflight) **gap** for concurrency |
| A scheduled write                                | Needs a second person's approval, bound to the exact definition; a new version needs approval again               | API (approvals)                                      |
| A schedule that runs as a named app registration | Uses only that identity's permissions; the run says "executed as app X"                                           | API (ADR-014)                                        |
| A schedule that runs as its creator              | Read-only; stops and asks for sign-in when the token can't be used; deleted with its tokens                       | API (ADR-014)                                        |

## Live accuracy

For every list page and report, `tests/live/scripts/check-accuracy.ts` compares what AdminForge shows with an
independent Graph query against the validation tenant — counts, membership and flags — using the Phase F fixtures,
whose answers are known in advance. Differences are reported per page; a page passes when they match or the difference
is a documented Microsoft behaviour (eventual consistency, report delay).

First run (2026-10-17, host services, 25 definitions, 70 checks): 60 match, 2 mismatch, 5 documented, 3 not knowable
(Phase E reports not yet published). Covered: the users list (fixture users, attributes, department facet) and its
KPIs, the identity overview counts and Conditional Access states, the groups list and KPIs, every fixture group's
members, nested groups, member and owner counts and owners list, group licensing, seven user pages (manager chain with a
disabled manager, licences direct and through a group, group membership, password never expires), authentication
methods, disabled users with licences, groups and apps without owners, password policies, app registrations (owners,
secrets, certificates, days to expiry), credential expiry and hygiene, app registration risks, the SAML enterprise app,
the AF-Audit Conditional Access policies, the named location, SKU seats, the sign-in accounts' sign-ins, PIM eligibility,
Intune compliance and configuration policies, and the registration report. The mismatches and follow-ups are in
`docs/backlog.md` › Live accuracy (2026-10-17).

Learned from it — Graph v1.0's `/groups/{id}/owners` list can leave out service-principal owners that `owners/$count`
and `$filter=owners/$count eq 0` count (Microsoft 365 groups created with application permissions keep the creating app
as owner); use the type casts (`/owners/microsoft.graph.user`, `/owners/microsoft.graph.servicePrincipal`) when a page
must list every owner.
