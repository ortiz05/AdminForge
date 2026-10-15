# AdminForge backlog

Gaps found while building. Each item names where it lands. Items move to a phase plan when scheduled.

## Security (before write playbooks go live)

- [x] **Secret outputs** (done): `secretOutputs` on playbook steps. Temporary passwords, Temporary Access Passes and new app secrets are shown once to the initiator over the live stream, never persisted (a redacted marker is stored), never in audit/export. Used by identity.reset-password, identity.issue-tap and identity.rotate-app-secret; identity.create-user issues its first credential through those child runs.
- [x] `$secureRandom(len)` helper (crypto-backed); `create-user` uses it for the throwaway initial password instead of JSONata `$random()`.
- [x] Security review (2026-10-15) — fixed: open redirect via dot segments; `auth_time`-proven step-up; browser-bound
      sign-in round trips; roles re-checked every 5 min; schedule approvals bound to the playbook fingerprint;
      current-version-only runs; scheduled data limited to Operators; connection audiences; `redact: true` masking;
      provisioning ceiling for automation write permissions; env-file split; DB isolation; Caddy admin API off. See
      `SECURITY.md`.
- [ ] Rotate the session id when write access is turned on (`auth/arm-routes.ts`): issue a new sid, re-key both
      token-cache partitions, and re-key `runs.session_hash` and pending show-once secrets in one transaction, so a
      cookie stolen while read-only can't ride a later arm.
- [ ] Anchor the audit chain outside the database: periodically write an HMAC (key outside Postgres) of the head hash
      to a file or the journal, and verify against it, so a database writer can't rewrite the tail.
- [ ] Re-validate definitions loaded from the database (`definitions/db-store.ts`): schema-parse and re-hash on load
      (cached by sha256), refusing rows that don't match.
- [ ] Response-size cap in `createHttpClient` (stream and stop at N MB) as a backstop to KQL `take` limits.
- [ ] Child runs: check the child playbook's `requires.portalRoles` and `confirm` against the initiator
      (`runs/children.ts`).
- [ ] Run AdminForge as a dedicated system user with system units (filesystem isolation: `ProtectSystem=strict`,
      `ProtectHome`, `ReadWritePaths`), which user units can't enforce on Ubuntu 24.04.

## Schema / content model

- [ ] Licence state in the expression scope (`licences.signInLogs`) so a page can drop P1-only `$select` fields instead of gating the whole page (users list + signInActivity).
- [ ] `graphBatch` paging (`@odata.nextLink` per sub-request).
- [ ] Per-row `inspect.page` expression (mixed row types).
- [ ] Playbook `tests` can set `now` and `env`.
- [ ] Column kind naming: table columns use `guid`, keyValue fields use `id` (docs/widgets.md now matches both schemas); accept either name in both.
- [ ] `widgets.md`: document `empty.action` (an action: `label` + `playbook`/`inputs` or `href`). It renders in every widget panel except `table`, whose empty state shows only `title`/`body`.
- [ ] Table `pageSize` and `selection: single` are accepted by the schema but not implemented by the table widget (it scrolls with "Load more"; `single` behaves like unset).
- [x] Probe schedules: `job.refs` (list) or a tag selector (`job.select: { tags: [hourly] }`) so one schedule sweeps many probes (today: one schedule per probe).
- [ ] ARM `apiVersion` from an expression or a per-resource-type lookup, enabling a generic "get resource by id".
- [x] Expression helpers `$kql(s)` (KQL string literal quoting — R12) and `$uuid()` (fresh GUID, e.g. role assignment names).
- [ ] Datasource fan-out (one call per row of another datasource) and simple joins.
- [ ] `logQuery` widget — R12. (Query Studio `/query` with save as report/probe/schedule is done.)
- [x] `kql` probe/check kind over Resource Graph, Log Analytics, advanced hunting — R12.
- [x] Licence-threshold probe `sku` from `${env.X}` so SKUs aren't literals.
- [ ] Approval policy for bulk runs: one approval for the whole bulk run (today each child run asks).
- [ ] `POST /api/runs/:id/input/:stepId` for input steps (today manual steps accept `values`).

## Delivery & notifications

- [ ] Report delivery by email and Teams: the schedule schema already accepts `email` and `teams` delivery targets (and `notify` targets), but the scheduler records them as `not_supported` and keeps the file instead. Needs the senders plus config keys (`AF_REPORT_RECIPIENTS`, `AF_TEAMS_WEBHOOK_URL`).
- [ ] Notify approvers when an approval gate opens (approver list in the NOTIFY payload + email/Teams).

## Engine & runner

- [ ] `http` step host allowlist (config `AF_HTTP_ALLOWED_HOSTS`); today `http` steps fail with `http_not_supported`.
- [ ] PowerShell steps for scheduled (automation) runs: app-only Exchange/Teams/PnP via certificate auth in the runner.
- [ ] Runner HMAC already binds method + path; consider mTLS if the runner ever leaves loopback.

## Platform

- [ ] Probe "not configured" state: a probe whose required env key is empty should report `skipped` (not `error`) — e.g. DNS probes without `AF_MAIL_DOMAIN`.
- [ ] Run datasource `transform`s off the API event loop (worker_threads pool) with a larger budget (today 250 ms on the main thread — large tenants, e.g. >2–4k guests, time out). `identity.inactive-guests` and its Monday schedule `reports.inactive-guests-weekly` hit this first: Graph can't combine a `signInActivity` filter with `userType`, so the 90-day window is applied in the transform.
- [x] Tenant-data guard and `forbiddenValues` (CLI fixture recording) exempt `https?://localhost.*`, which also lets `http://localhost.<domain>` through; anchor it to `localhost(:port)/?` in both places.
- [x] Enforce formatting: Prettier (repo formatted once) is checked in CI (`pnpm format:check`) and applied by the Claude Code after-edit hook; the pre-commit hook runs only the guard tests. `portal/content`, fixtures and `docs/plans` are excluded (`.prettierignore`).
- [x] Read-mode allowlist: Graph `POST /directoryObjects/getByIds`; ARM `…/config/appsettings/list` with values stripped server-side (names only; the read is audited).
- [ ] Example connection `connections/hr-sync`: env keys for base URL + audience.
- [x] Default Log Analytics workspace key (`AF_LOG_ANALYTICS_WORKSPACE_ID`).

## Navigation / product

- [x] Decide between the content "Probe dashboard" and the coded `/monitoring` page (keep one entry in nav).
- [ ] Merge `security.compromised-account-response` and `identity.compromised-account` runbooks.
- [ ] Weekly schedule for the `identity.inactive-users` report (the report exists; add a schedule like `reports.inactive-guests-weekly`).
- [ ] `identity.disable-user` typed confirmation asks for the UPN; for guests that is the `…#EXT#@…onmicrosoft.com` form (the "Block sign-in" action on `identity.inactive-guests`). Consider confirming guests on `mail`.
