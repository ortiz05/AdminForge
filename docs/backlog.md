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
- [x] Playbook `tests` can set `now` and `env` (per test).
- [ ] Licence declarations: the API capabilities map has no Entra ID P1 feature key (the licenceGate widget already knows `entraP1`/`entraP2`), so P1-only content declares the service plan `AAD_PREMIUM` (e.g. `identity.edit-dynamic-rule`), which page gates resolve to the Conditional Access feature. Add `entraP1` to `FEATURES` and `FEATURE_KEYS`.
- [ ] Playbook preflight (`apps/web/src/playbooks/Preflight.tsx`) checks `requires.licences` against SKU part numbers only, so feature keys (`pim`, `intune`, …) and service plans always show "Requires …"; resolve them through `featureKeyFor` like page gates do.
- [ ] Licences an optional path needs (dynamic membership in `identity.create-group`, group assignment in `identity.assign-app-access`) can only be declared for the whole playbook; a per-input or per-step `requires.licences` would let the form explain them.
- [ ] Column kind naming: table columns use `guid`, keyValue fields use `id` (docs/widgets.md now matches both schemas); accept either name in both.
- [ ] `widgets.md`: document `empty.action` (an action: `label` + `playbook`/`inputs` or `href`). It renders in every widget panel except `table`, whose empty state shows only `title`/`body`.
- [x] Table `selection: single` implemented; `pageSize` is moot with virtualised tables (kept for compatibility, see docs/decisions.md).
- [x] Probe schedules: `job.refs` (list) or a tag selector (`job.select: { tags: [hourly] }`) so one schedule sweeps many probes (today: one schedule per probe).
- [ ] ARM `apiVersion` from an expression or a per-resource-type lookup, enabling a generic "get resource by id".
- [x] Expression helpers `$kql(s)` (KQL string literal quoting — R12) and `$uuid()` (fresh GUID, e.g. role assignment names).
- [ ] Datasource fan-out (one call per row of another datasource) and simple joins.
- [x] ~~`logQuery` widget~~ — superseded by the `logAnalytics` datasource with table/chart widgets and Query Studio (docs/decisions.md).
- [x] `kql` probe/check kind over Resource Graph, Log Analytics, advanced hunting — R12.
- [x] Licence-threshold probe `sku` from `${env.X}` so SKUs aren't literals.
- [ ] Approval policy for bulk runs: one approval for the whole bulk run (today each child run asks).
- [ ] `POST /api/runs/:id/input/:stepId` for input steps (today manual steps accept `values`).
- [x] Query-builder filters for runner/static lists: `filters.advanced.dialect: rows` + `$applyAdvanced(rows, advanced)`
      (used by `m365.mailboxes`). The `client` dialect is still accepted by the schema but not offered by the renderer.
- [ ] `rows` dialect: each distinct filter re-runs the runner job (the cache key includes params). Cache the raw script
      output separately from the transform so filters and facets reuse one scan.
- [ ] Teach `requiresText` (NavRail) a short name for `TVM_PREMIUM_1` (Defender Vulnerability Management); the badge
      shows the raw service plan name today.

## Delivery & notifications

- [x] Report delivery by email and Teams (`delivery/notifier.ts`): Graph sendMail from `AF_MAIL_SENDER`, Teams Workflows webhooks; also `notify.onFailure`/`onSuccess`. Live validation is licence-blocked (no Exchange/Teams in the validation tenant).
- [x] Notify approvers when an approval gate opens or a write schedule asks to be enabled (`AF_APPROVALS_EMAIL`, `AF_APPROVALS_TEAMS_WEBHOOK`).

## Engine & runner

- [ ] `http` step host allowlist (config `AF_HTTP_ALLOWED_HOSTS`); today `http` steps fail with `http_not_supported`.
- [ ] PowerShell steps for scheduled (automation) runs: app-only Exchange/Teams/PnP via certificate auth in the runner.
- [ ] Runner HMAC already binds method + path; consider mTLS if the runner ever leaves loopback.

## Platform

- [x] History retention (runs, schedule history, probe results, report files), audited; `adminforge audit verify`;
      hourly `probes.audit-chain`; worker/scheduler heartbeats in `/readyz`; per-call telemetry logs; daily backups.
- [ ] OpenTelemetry/metrics export (`/metrics` on loopback or OTLP) and a portal-health dashboard from internal metrics
      (run success, armed sessions, 429s).
- [ ] Capabilities: Azure RBAC on a scope and "missing scopes" in `/api/me/capabilities` (PIM-aware preflight for ARM).
- [ ] CAE claims challenge during a write: carry the claims through re-arm and return to the page.
- [ ] Personal dashboards: pin widgets to "My dashboard" and arrange them (plan 7.4).
- [ ] Function App logs/traces on the Function App page; Function Apps health dashboard; domain-expiry probe (RDAP).
- [ ] Delta queries for large Graph lists.

- [ ] Probe "not configured" state: a probe whose required env key is empty should report `skipped` (not `error`) — e.g. DNS probes without `AF_MAIL_DOMAIN`.
- [ ] Run datasource `transform`s off the API event loop (worker_threads pool) with a larger budget (today 250 ms on the main thread — large tenants, e.g. >2–4k guests, time out). `identity.inactive-guests` and its Monday schedule `reports.inactive-guests-weekly` hit this first: Graph can't combine a `signInActivity` filter with `userType`, so the 90-day window is applied in the transform.
- [x] Tenant-data guard and `forbiddenValues` (CLI fixture recording) exempt `https?://localhost.*`, which also lets `http://localhost.<domain>` through; anchor it to `localhost(:port)/?` in both places.
- [x] Enforce formatting: Prettier (repo formatted once) is checked in CI (`pnpm format:check`) and applied by the Claude Code after-edit hook; the pre-commit hook runs only the guard tests. `portal/content`, fixtures and `docs/plans` are excluded (`.prettierignore`).
- [x] Read-mode allowlist: Graph `POST /directoryObjects/getByIds`; ARM `…/config/appsettings/list` with values stripped server-side (names only; the read is audited).
- [ ] Example connection `connections/hr-sync`: env keys for base URL + audience.
- [x] Default Log Analytics workspace key (`AF_LOG_ANALYTICS_WORKSPACE_ID`).

## Exchange / Teams / OneDrive / Defender (fixture-validated only)

- [ ] Inbox rules: a write playbook to disable or remove a rule (`Disable-InboxRule` / `Remove-InboxRule`) wired as a
      row action on `m365.inbox-rules`. Today the report points people to Outlook or PowerShell.
- [ ] Send on Behalf (`GrantSendOnBehalfTo`) is shown on the mailbox's Access tab but not managed; add it to
      `Set-MailboxPermission.ps1` (`Set-Mailbox -GrantSendOnBehalfTo @{Add/Remove}`) and the two playbooks.
- [ ] OneDrive access: the SharePoint admin API adds site collection admins but can't list or remove secondary ones,
      so `m365.grant-onedrive-access` can't verify or compensate. Verify/remove through a site-scoped PnP connection
      (token for `<tenant>-my.sharepoint.com`) once the runner can request one.
- [ ] Clear forwarding has no automatic undo (by design: restoring a forwarding target should be a decision). The run
      output keeps the previous targets.
- [ ] Intune `managedDevices` `$filter`: the query-builder fields/operators on `endpoint.devices` (eq, OS version
      startsWith, date ranges, enrolment type, management state, encryption) follow Microsoft's documentation but are
      not live-validated (no Intune licence). Trim any Intune rejects.
- [ ] Defender device links (`security.microsoft.com/machines/v2/<id>/overview`) and CVE links: confirm the URL formats
      on a licensed tenant.
- [ ] The leaver runbook (`identity.leaver`, section 5 "Mailbox, OneDrive and access") still lists the mailbox and
      OneDrive tasks as manual; `identity.offboard-user` 1.1.0 now does them. Identity owners: trim the checklist.
- [ ] Scheduled (automation) inbox-rule scans need app-only Exchange in the runner (see Engine & runner).

## Navigation / product

- [x] Decide between the content "Probe dashboard" and the coded `/monitoring` page (keep one entry in nav).
- [ ] Merge `security.compromised-account-response` and `identity.compromised-account` runbooks — merged into `identity.compromised-account` 2.0.0 (nav moved to Security); still to do: retire `security.compromised-account-response` (`status: retired`, version 1.1.0) so it leaves navigation.
- [ ] Weekly schedule for the `identity.inactive-users` report (the report exists; add a schedule like `reports.inactive-guests-weekly`).
- [ ] `identity.disable-user` typed confirmation asks for the UPN; for guests that is the `…#EXT#@…onmicrosoft.com` form (the "Block sign-in" action on `identity.inactive-guests`). Consider confirming guests on `mail`.
