# Enterprise-scale performance tests

How AdminForge's page loads behave for a large enterprise: every datasource against a synthetic 100k-user tenant
(budgets that fail the build when something gets slower or bigger), and a load test with many engineers at once.
Results and the sizing guide: [docs/performance.md](../../docs/performance.md).

| Command                                                                 | What                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm test:perf`                                                        | Fake Graph checks plus every page/dashboard/report datasource with its budget (~3–4 min, ~4 GB heap)       |
| `AF_PERF_ONLY=identity pnpm test:perf`                                  | Only pages whose key matches the regex                                                                     |
| `AF_PERF_SCALE=small pnpm test:perf`                                    | A 2k-user tenant (budgets are for `enterprise`; use for quick iteration, expect budget noise)              |
| `AF_PERF_VERBOSE=1 pnpm test:perf`                                      | One line per datasource while it runs                                                                      |
| `AF_PERF_RECORD=1 pnpm test:perf`                                       | Rewrites `budgets.json` from this run (keeps written reasons)                                              |
| `pnpm --filter @adminforge/tests exec tsx perf/load.ts --sessions 1000` | Load test; options in the header of `load.ts` (`--duration`, `--mix default\|light`, `--set KEY=VALUE`, …) |

Not part of `pnpm test` (the `perf` vitest project only runs through `test:perf`, which sets `AF_PERF=1`).

## Pieces

- `tenant/` — `createTenant(scale)`: a deterministic synthetic tenant (seeded; `example.com`; names with apostrophes,
  non-Latin scripts and very long values). Group membership and the logs (1M sign-ins a day for 30 days) are computed,
  not stored. `collection.ts` is the `{ size, at(i) }` shape the fake pages over.
- `graph/` — `createFakeGraph(tenant)`: Graph's paging, `$top` caps (999; 120 with `signInActivity`), `$count` /
  `/$count` / `$search` / advanced queries only with `ConsistencyLevel: eventual`, `$expand` (20 members max),
  `$batch`, `getByIds`, usage reports as JSON, log scans with a work budget per page, latency and 429 injection.
  Unknown query options or filter syntax → 400; unknown paths → 404 `SyntheticNotModelled` (listed in the report).
  Azure (ARM, Resource Graph, Log Analytics) and the PowerShell runner are not modelled.
- `harness/` — `runAllDatasources` (the real `DatasourceRunner` and outbound executor, one datasource at a time so
  requests, bytes and time are attributed), `budgets.ts` (checks and recording), `report.ts` (`out/`, gitignored).
- `budgets.json` — the default every datasource must meet and the entries for those that don't yet, each with its
  reason. Fixing a datasource means shrinking or deleting its entry; new content must meet the default.
- `fake-server.ts` + `load.ts` — the load test: the API in-process (Entra auth with the test fake, live data mode),
  the fake Graph in separate processes (its work must not count as API latency).

## Reading a failure

| Message                                                 | Meaning                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `error: content_error — … timed out after 250 ms`       | The transform can't handle enterprise volume (filter at the source, or untransformed rows) |
| `crawl stopped at maxItems … silently cut`              | `paging: all` reached `maxItems` with data left: results are incomplete at this scale      |
| `N requests > M` / `MB > …` / `≈ s live > …`            | More pages, bytes or (requests × 250 ms + transform) than its budget                       |
| `calls a Graph path the synthetic tenant doesn't model` | Add the path to `graph/fake-graph.ts` (with realistic data in `tenant/generate.ts`)        |
| `now succeeds` (printed, not a failure)                 | A known error was fixed: delete its entry from `budgets.json`                              |
