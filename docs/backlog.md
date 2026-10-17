# AdminForge backlog

Gaps found while building. Each item names where it lands. Items move to a phase plan when scheduled.

Plan for the Microsoft 365 E5 features (Entra ID P1/P2, Intune, Defender for Endpoint) and the tooling layout:
`docs/plans/2026-10-16-m365-e5-unlock-and-tooling.md`. Deferred tooling items from it: a shared helper module for Exchange content
scripts (needs a read-only allow-list decision), one certificate/PEM implementation shared by the CLI and the API.

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
- [x] Response-size cap in `createHttpClient` (`OUTBOUND_MAX_BYTES`, streamed).
- [x] Child runs check the child playbook's `requires.portalRoles` against whoever runs them.
- [x] Second security review (2026-10-15, API + identity/RBAC) — fixed: connection scopes and audience allow-list,
      `invalid_grant` ends sessions, control characters in paths, guests refused (`acct`), step-up always forced,
      query params out of logs, mock mode fenced, response caps, HTTP-probe SSRF, expression limits, `/readyz` cache,
      server-side correlation ids; current-version-only data and exports, delivery recipients from configuration only,
      manual-step values from the right person, scheduled-run output visibility, connection-aware approval
      fingerprints, redaction after resume, safe Markdown links, approver and child roles, drafts can't run,
      single-use previews; runner tokens sealed and answers signed, read-mode command policy; provisioning ceilings
      (tier-0 Write scopes, sensitive automation reads), unexpected-privilege status, `acct` claim, automation
      assignment required and certificate support, https-only redirects, validation user hardened and disabled between
      runs; playbooks refuse AdminForge's own groups and apps; services on a least-privilege database role; backups
      without admin credentials or CA keys. See `SECURITY.md`.
- [ ] Child confirmation: a child playbook's typed confirmation isn't asked when a parent starts it; validation only
      requires the parent to have a `confirm` block. Align `identity.create-user`, `azure.new-subscription-onboarding`
      (medium parents with high children), `identity.compromised-account`, `identity.leaver` and
      `security.compromised-account-response` (click parents with typed children), then require parent risk and confirm
      type ≥ the child's.
- [ ] Constrained runspace for read-mode PowerShell: run read jobs in a ConstrainedLanguage `InitialSessionState`
      runspace with only allow-listed commands visible (keeping the static policy). Blocked by CLM-incompatible lines in
      six read scripts (Generic `List::new()`, `[Math]`, `[Convert]` — listed in the runner fix notes): rewrite them,
      re-pin hashes, and live-check Exchange/Teams/PnP connections in a non-default runspace.
- [ ] Live-check the runner's read-mode guards (Graph and Az guarded, module auto-loading off) on the Exchange, Teams
      and SharePoint read pages once those workloads are licensed (`pnpm test:live`). SharePoint (PnP) read pages work
      in read mode (2026-10-16); Teams: see the Teams PowerShell item under Exchange / Teams / OneDrive / Defender.
- [ ] Sign the runner's `/healthz` and cancel answers; optionally encrypt runner answers.
- [ ] HTTP probes: close the DNS-rebinding window between the address check and the fetch (pinned-address
      dispatcher); TLS and DNS probe checks can still reach internal hosts and ports.
- [ ] Connection audiences: resolve the service principal and require `appOwnerOrganizationId` = tenant for GUID and
      `api://` audiences.
- [ ] Expressions: string concatenation (`&`) can grow strings without a size check.
- [ ] Definitions loaded from the database aren't re-validated, so validation-only rules (child confirmation, `$eval`,
      recipient keys) aren't enforced at run time for rows that bypassed the CLI.
- [ ] Manual steps that take values can't be completed in automation runs.
- [x] Key-value `link` fields with no `href` used to evaluate the data value as a template; the value is now used
      literally, and only for external URLs (2026-10-16).
- [ ] A separate "Write-Privileged" app (own group, own authentication context with phishing-resistant MFA) for the
      tier-0 Write scopes, so routine armed sessions don't hold them.
- [ ] Separate app registrations per environment label (today `pnpm dev` and the host services share the Read/Write
      apps and their secrets).
- [ ] Scope the validation user's User Administrator role to an administrative unit holding the `AF-Test-*` objects
      (Entra ID P1), or make the privileged groups role-assignable.
- [x] Security review of the licensed build-out (2026-10-16): `optional` datasources never hide a denial anywhere in
      the chain and record what they suppress (scheduled reports end `report_incomplete`); the validation user's
      Exchange / SharePoint admin roles are opt-in (`AF_TEST_SERVICE_ADMIN_ROLES`); provisioning refuses accounts it
      didn't create; `provision status` flags any other directory role of the validation user; live scripts refuse the
      services' database, playbook schedules and non-test mailboxes and mask messages.
- [ ] Replace the validation user's tenant-wide Exchange Recipient Administrator / SharePoint Administrator (opt-in)
      with scoped grants: an Exchange RBAC management scope over the `AF-Test-*` recipients, and site collection admin
      on the `AF-Test-*` sites — then retire `AF_TEST_SERVICE_ADMIN_ROLES`.
- [x] `provision status` checks the validation user's active and group-held directory roles, not PIM-eligible ones
      (`roleEligibilitySchedules`, needs Entra ID P2): an eligible role could be activated with its stored password.
      Done: eligible roles of the validation user and the approver are checked (`provision/eligibility.ts`); the
      provisioner needs `RoleEligibilitySchedule.Read.Directory` (or the pim fixture's ReadWrite) to read them.
- [ ] Licensed test fixtures still to build (M365 E5 plan, Phase 1): a report-only Conditional Access test policy
      `AF-Test-CA` on AF-Test-Group-01 once the owner chooses Conditional Access over Security Defaults, and a risky
      user on demand ("confirm compromised" then "dismiss" on AF-Test-User-03) with the Identity Protection live checks.
- [ ] Live suite: approval flows with the approver fixture (`testApproverCredentials`) — the validation user requests,
      AF Tester 2 approves (mailbox forwarding, critical playbooks, write-capable schedules).
- [ ] Validation users created before the "AdminForge validation" marker are recognised by their display name; set the
      marker on them (`employeeType`) and then require it.
- [ ] Show "incomplete" on a page when a datasource ran without a failed `optional` one (`errors["ds.<name>"]` is in
      the response; the renderer ignores it), and tell the person when an interactive export is incomplete (today it is
      audited and logged only). graphBatch sub-request failures in exports aren't marked incomplete either.
- [ ] Trim the automation baseline to what built-in code needs (Application.Read.All, AuditLog.Read.All,
      Organization.Read.All, Policy.Read.All); Device.Read.All is unused.
- [ ] Move Read-app pages that need `Exchange.Manage`, `AllSites.FullControl` or Teams to a narrower identity.
- [ ] Decide whether `UserAuthenticationMethod.ReadWrite.All` (TAPs for admins) belongs in the tier-0 list.
- [ ] `provision entra` retires stale extra client secrets (status flags them today; nothing removes them).
- [ ] Re-issue the automation identity's credential as a certificate on this host (`AF_AUTOMATION_CERT_PATH`); move
      `AF_AUTOMATION_*` to an env file only the scheduler and worker read.
- [ ] **High.** Run AdminForge as a dedicated system user with system units (filesystem isolation:
      `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths`), which user units can't enforce on Ubuntu 24.04 — not in
      the `docker`/`sudo`/`lxd`/`adm` groups, with no other services under it, and with Postgres it can't administer.
      Until then any process of the same account can read the configuration (SECURITY.md → Host and network).

## Platform evaluation (2026-10-16): not yet done

Found by the organization and security evaluation; the fixed findings are in CHANGELOG.md.

- [ ] Per-user limits: active and queued runs, open run streams (`/api/events` is capped at 5 per session), and rate
      limits keyed by user rather than IP for signed-in routes.
- [ ] Bulk-action links can carry `$label`s that are shown next to the real targets: resolve display names in the
      preview server-side and show only those.
- [ ] Other Operators see the inputs and outputs of someone else's delegated run (collected with that person's Entra
      rights): limit them to metadata unless they approve the run, or let content mark outputs sensitive.
- [ ] Certificate credentials for the Read and Write apps; derive separate keys (HKDF) with a key id from
      `TOKEN_CACHE_KEY` for the token cache and run-secret hand-offs, so it can be rotated without signing everyone out.
- [ ] Session management for users: list and end your other sessions; front-channel logout.
- [ ] Connection operations declared `mode: read` may POST and are callable without arming: require GET, or a reviewed
      `readPost: true`.
- [ ] Publishing through its own database role (insert on `definitions` only) and a named publisher/approver on each
      row; today the services' role can insert and update definitions and schedule approval columns.
- [ ] Runner modules: record a SHA-256 per package in `modules.lock.json` and verify it at install and at runner start;
      check Authenticode signatures; pin the runner's base images by digest; install runtimes to root-owned paths.
- [ ] Alerting on AdminForge itself: probe sweeps and the backup notify on failure; a readiness check from another
      host; probes for backup freshness and disk space.
- [ ] CI: SAST (CodeQL), SBOM, secret scanning (gitleaks), a runner image build, and a job that runs the runner's
      read-mode guards against the pinned modules (today those tests skip without them); skipped Postgres or module
      tests should fail when `CI=true`.
- [ ] Runs waiting on a `wait` step stay `running` and aren't version-checked on wake-up; approval `excludes` doesn't
      cover a service principal's owners.
- [ ] Datasource transforms on the API thread are also a denial-of-service lever (any Reader, varying parameters to
      bypass the cache) — see Platform.
- [ ] Code organization: move db, definitions, audit, outbound, runs, schedules, probes and news from `apps/api` into a
      server package the scheduler and CLI import (today they deep-import `@adminforge/api/src/*`); split
      `execution/outbound.ts`, `runs/service.ts`, `engine/src/engine.ts` and `probes/checks.ts` along their seams;
      share the GUID pattern, `sleep` and backoff helpers; `typecheck` shouldn't build the apps (`turbo.json`); move
      real-pwsh tests out of the unit project.
- [x] Content: merge `identity.licence-utilization` and `m365.licence-utilization` — done 2026-10-17 (the identity one is
      retired; seats stay in Licence utilization, group licensing errors moved to Licence assignment errors).
- [ ] Content: one SKU-name map (YAML copies and `web/src/lib/overview.ts`); one spelling of utilisation;
      `reports.app-credential-expiry` → a cadence suffix.
- [ ] Docs: a test that every API error code is documented exactly once (`docs/troubleshooting.md`); a skill for
      adding an expression helper.
- [ ] Docs: `docs/decisions.md` (D1/D2 and "Validation tenant specifics") records installation details — the repository
      handle, LAN port, the validation tenant's licences — against the rule in `docs/onboarding/11-documentation.md`;
      move them to operator notes outside the repository or generalise them.
- [ ] CI: the failure artifact uploads `tests/playwright-report`, but the e2e reporter is `list`, so it is always
      empty; add an `html` reporter in CI (or upload `test-results/e2e`).
- [ ] Repository settings (onboarding guide 10): squash merging only, PR title as the default commit message, branch
      protection with required reviews and code-owner review once the plan allows it, and more code owners so nobody's
      sensitive change waits on themselves.

## Schema / content model

- [ ] `m365.sharepoint-sharing` and `m365.sharepoint-site` build their "Open in SharePoint admin center" actions from
      `env.AF_SPO_TENANT_NAME`, but row and page actions are evaluated in the browser, which has no `env`: the action
      never appears. Read the value in a `source: static` datasource (as the AVD pages do) and use that; and have
      `validate` refuse `env.` in row/page action templates (found 2026-10-17).
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
- [ ] Make `kind: boolean` (cell and facet) also accept 1/0 and `'true'`/`'false'` text, so computed Resource Graph
      flags work without a status map.
- [ ] Datasource fan-out (one call per row of another datasource) and simple joins. Wanted by: members of
      role-assignable groups, app install failures per app, last sign-in per shared mailbox.
- [ ] Graph/ARM probe metrics beyond counts: a value from the response (Secure Score drop, budget percentage).
      (`graphCount` covers counts: Global Administrators, role-group changes.)
- [ ] Intune report POSTs as reads (`/deviceManagement/reports/get*Report`) — unblocks an app install failures report.
- [ ] Multi-sheet XLSX exports (the scheduled OS-versions file has only the release summary).
- [ ] Schedules that export pages (not only reports).
- [ ] A licence feature key for Microsoft 365 usage reports, so `m365.inactive-licensed-users` can be gated.
- [ ] Usage-report transforms near the 250 ms budget at ~100,000 users: move counting into the query or summarise
      server-side.
- [ ] Linux compliance in the compliance-gaps report (Linux policies live in the settings catalog).
- [ ] Re-check on a licensed tenant: mailbox `recipientType`, team activity `details[]`, the
      `RequireDeviceCompliancePolicyAssigned` setting name, Exchange `AccountDisabled`, PIM requests outside `$batch`.
      (Team activity: the Office 365 E5 validation tenant still gets 404 `UnknownTenantId` from the usage reports on
      2026-10-16 — Microsoft starts them 24–48 h after the first subscription.)
- [ ] Playbooks: revoke an application permission; remove a credential from a service principal; delete orphaned Azure
      resources (with approval); disable or remove inbox rules; manage Send on Behalf.
- [ ] `identity.inactive-guests`: the unredeemed-invitations view should work without Entra ID P1.
- [ ] Azure: `getByIds` batching beyond 3,000 principals; an option to give the automation identity Reader at a
      management group; review the App Service end-of-support list quarterly; sub-groups in the Reports navigation.
- [x] Enable `reports.azure-monthly-cost-weekly` — enabled with Azure Billing (2026-10-17); it needs Cost Management
      Reader on the management group for the automation identity (see "Azure Billing" below).
- [x] ~~`logQuery` widget~~ — superseded by the `logAnalytics` datasource with table/chart widgets and Query Studio (docs/decisions.md).
- [x] `kql` probe/check kind over Resource Graph, Log Analytics, advanced hunting — R12.
- [x] Licence-threshold probe `sku` from `${env.X}` so SKUs aren't literals.
- [ ] Approval policy for bulk runs: one approval for the whole bulk run (today each child run asks). With it, bulk
      limits enforced server-side: playbooks declare `bulk: { allowed, maxItems }` (today a page's `maxItems` and
      `when` are client-side only and `POST /api/runs/bulk` takes up to 1,000 items for any playbook), and high or
      critical playbooks without their own approval need one for a bulk run.
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
- [x] Report schedules created in the portal (Reports → Schedule; `schedules/portal.ts`, 2026-10-16), hardened after
      the security review (creator check before each run, atomic caps, plain-text names, Markdown escaping in Teams,
      redacted params masked everywhere).

## Engine & runner

- [ ] `http` step host allowlist (config `AF_HTTP_ALLOWED_HOSTS`); today `http` steps fail with `http_not_supported`.
- [ ] PowerShell steps for scheduled (automation) runs: app-only Exchange/Teams/PnP via certificate auth in the runner.
- [ ] Runner HMAC already binds method + path; consider mTLS if the runner ever leaves loopback.

## Platform

- [ ] Reload after a deploy: the API serves the new build at once and the old lazy chunks are gone, so a tab opened
      before the deploy can fail to open a screen until it's reloaded. Catch a failed dynamic import (or compare a
      build id from `/api/me`) and offer a reload (found 2026-10-17).
- [ ] Initial JS is at 244.6 of 250 KB gzip (98 %, `pnpm check:bundle`, 2026-10-17): the next web dependency will
      break the budget. Move something out of the entry chunk (e.g. route-level splitting of the ops pages) first.
- [x] History retention (runs, schedule history, probe results, report files), audited; `adminforge audit verify`;
      hourly `probes.audit-chain`; worker/scheduler heartbeats in `/readyz`; per-call telemetry logs; daily backups.
- [ ] OpenTelemetry/metrics export (`/metrics` on loopback or OTLP) and a portal-health dashboard from internal metrics
      (run success, armed sessions, 429s).
- [ ] Capabilities: Azure RBAC on a scope and "missing scopes" in `/api/me/capabilities` (PIM-aware preflight for ARM).
- [ ] CAE claims challenge during a write: carry the claims through re-arm and return to the page.
- [ ] Personal dashboards: pin widgets to "My dashboard" and arrange them (plan 7.4).
- [ ] Domain-expiry probe (RDAP). (Function App logs and a Function Apps health dashboard were dropped 2026-10-17
      with the Function App content, see Hybrid Azure Arc servers below.)
- [ ] Delta queries for large Graph lists.

- [ ] Probe "not configured" state: a probe whose required env key is empty should report `skipped` (not `error`) — e.g. DNS probes without `AF_MAIL_DOMAIN`.
- [ ] Run datasource `transform`s off the API event loop (worker_threads pool) with a larger budget (today 250 ms on the main thread — large tenants, e.g. >2–4k guests, time out). `identity.inactive-guests` and its Monday schedule `reports.inactive-guests-weekly` hit this first: Graph can't combine a `signInActivity` filter with `userType`, so the 90-day window is applied in the transform.
- [x] Tenant-data guard and the CLI's fixture recording (now one rule: `tenantValues` in `@adminforge/config`) exempt `https?://localhost.*`, which also lets `http://localhost.<domain>` through; anchor it to `localhost(:port)/?` in both places.
- [x] Enforce formatting: Prettier (repo formatted once) is checked in CI (`pnpm format:check`) and applied by the Claude Code after-edit hook; the pre-commit hook runs only the guard tests. `portal/content`, fixtures and `docs/plans` are excluded (`.prettierignore`).
- [x] Read-mode allowlist: Graph `POST /directoryObjects/getByIds`; ARM `…/config/appsettings/list` with values stripped server-side (names only; the read is audited).
- [x] Dropped 2026-10-17: the example connection `connections/hr-sync` is retired with the Function App content (the
      generic `function` datasource and `functionHealth` probe stay; `adminforge new connection` scaffolds a new one).
- [x] Default Log Analytics workspace key (`AF_LOG_ANALYTICS_WORKSPACE_ID`).

## Engineer report library (plan 2026-10-17, phase E)

- [x] **Grouping constructor at scale (fixed 2026-10-17).** The "nested or recursing too deeply" failure came from
      JSONata evaluating every group's value at once (`Promise.all`), each pending evaluation counting towards the
      shared depth guard — any `rows{ key: <path> }` with more than ~500 keys failed. It now runs natively
      (`portal/packages/expressions/src/group-by.ts`, differential-tested against JSONata): 50k keys within budget.
- [ ] **Transform cost at enterprise scale (engine, phase A).** JSONata costs ~15 µs per row for a filter, a `$merge`
      or a mapped object (~0.15 ms for a rich per-row mapping), so per-row transforms fit ~1,500 rows. The rewritten
      content (2026-10-17) uses native `$applyAdvanced` / `$withFields` / `$take` and reaches 30–60k rows; beyond that
      it caps and says the data is partial. Engine follow-ups: (1) `plain()` in `expressions/src/evaluate.ts`
      deep-copies every transform result — ~70 ms for 27k usage rows, paid twice when a page view (`source: static`)
      copies a list datasource; copy only what needs it (copy-on-write, keeping it a fresh, prototype-safe value). (2) Run report and
      schedule transforms off the event loop with a larger budget (scheduled runs don't block a page). (3) Per-tenant
      snapshots (precomputed by the automation identity, read with an "as of" time and role gating) for the answers
      Graph can't give at the source: inactive and never-signed-in members at 100k, password age, usage reports
      beyond 40k accounts/sites, apps owned only by apps beyond 20k groups.
- [ ] Caps of the content rewritten for scale (2026-10-17; each page says when it is partial): inactive users —
      no successful sign-in recorded 3,000; password age — 60,000 members read, 10,000 findings listed (the export
      and the counts have all read); mailbox storage, OneDrive and SharePoint site usage, SharePoint sites — 40,000
      rows read, 10,000 listed (the export has all read); inactive licensed users 30,000; teams activity 8,000;
      identity health — inactive accounts 2,400, app
      credentials 10,000 apps; app registrations credential KPIs 10,000 apps; groups owned only by apps 20,000 groups
      read; teams without owners 10,000 teams.
- [x] (1) and (2) below are done: a non-streamed export reads at most the datasource's own `maxItems` (and marks the file
      truncated when that read stopped at its cap), and `dependency_failed` shows the dependency's own message, hint and
      sign-in link. (3) stays open.
- [ ] API follow-ups from the scale rewrite (2026-10-17): (1) exports run the export datasource with
      `maxItems = EXPORT_MAX_ROWS` (100k) instead of its own cap, so a list sized for the 250 ms transform budget can
      time out on export — content sets `export.maxRows` to the datasource's cap meanwhile; the export should keep
      `min(maxItems, EXPORT_MAX_ROWS)`. (2) `dependency_failed` messages name internal datasources ('Datasource
      "mailboxes" needs "mailboxList", which failed: …') and reach the page — e.g. every usage report's view while
      Microsoft has no usage data; show the dependency's own message and hint. (3) A transform can't tell a page load
      from an export, so a capped table exports through a second, list datasource that the page view copies
      (`m365.mailbox-storage`: `mailboxList` → `mailboxes`); an export flag in the transform scope would avoid the
      copy.
- [ ] Usage reports that still run their per-row transform and stop at 1,500 rows (marked partial): anyone-link
      sites. Rewrite like `m365.mailbox-storage` (native filters, Graph fields in the columns).
- [ ] Owner types: Graph's `GET /groups/{id}/owners` without a cast leaves service principals out (live 2026-10-17)
      while `$expand=owners` and `owners/$count` include them. Content now reads the casts or the expansion; the Graph
      owner-count views (`owners/$count eq 0|1`) can't tell people from apps, so "one owner" there means a person or an
      app — say so wherever such a view is added.
- [ ] Caps the new reports keep for that budget (each says so on the page; a join whose lookup list was cut short
      shows nothing rather than false findings): Conditional Access report-only impact 300 Graph sign-ins (every
      sign-in through Log Analytics), BitLocker escrow 2,000 devices/keys, Windows LAPS 1,500 devices/backups, unused
      applications 1,000 apps/sign-in records (2,000 grants), authentication method strength 1,000 users, licence
      assignment errors 500 rows per list, group lifecycle 2,000 per list, SAML 500 apps, the manager check 5,000 users.
      Each transform is tested at its cap against the 250 ms budget (+20 %) in `tests/content/engineer-report-library.test.ts`.
- [x] `reports.stale-devices-weekly` and `reports.non-compliant-devices-daily` are on (1.1.0): `endpoint.stale-devices`
      and `endpoint.non-compliant-devices` 2.0.0 filter natively and meet their perf budgets at enterprise scale.
- [ ] Conditional Access report-only impact through Log Analytics (`SigninLogs`, `mv-expand ConditionalAccessPolicies`)
      is untested live: no workspace receives the validation tenant's sign-in logs. Check it once a workspace is set.
- [ ] BitLocker escrow and Windows LAPS coverage aren't scheduled: the automation identity would need
      `BitlockerKey.ReadBasic.All` and `DeviceLocalCredential.ReadBasic.All` (metadata only). Both were only path-checked
      live (403 for the automation identity); check them with the validation user once the Read app has
      `DeviceLocalCredential.ReadBasic.All`.
- [x] `probes.arm-subscription-access` failed while `AF_SUBSCRIPTION_ID` is unset (the path became
      `/subscriptions//resourcegroups`). Graph, ARM and graphCount probes whose path names an unset `env.X` now report
      `not_configured` ("AF_SUBSCRIPTION_ID is not set, so this check has nothing to look at") without calling anything
      (`probes/checks.ts` `requireConfiguredPath`, tests/unit/api/probe-unset-setting.test.ts).
- [ ] A probe for single Graph objects with an expiry (the Apple MDM push certificate, which is the most damaging one to
      lose): `graphCount` reads lists only. Needs a `graphValue`-style check kind; the connector health report covers it.
- [ ] Licence assignment errors: users holding the same SKU directly and through a group (blocks licence clean-up)
      can't be found server-side — `licenseAssignmentStates` isn't filterable and `any(… ne null)` is refused.
- [ ] SAML certificate expiry follows the signing certificate that expires last: the active one is only exposed as
      `preferredTokenSigningKeyThumbprint` (hex), which can't be matched to `keyCredentials[].customKeyIdentifier`
      (base64) in an expression.
- [ ] `AF_LICENCE_SKU_1` / `AF_LICENCE_SKU_2` are now used only by the retired fixed-SKU seat probes; drop them from
      `config/example.env` (and the env check) once no installation sets them.
- [x] `reports.app-credential-expiry` and `reports.app-credential-expiry-daily` are not duplicates: a daily CSV kept for
      a month and the weekly XLSX archive kept for a quarter. The cadence-suffix rename stays under Platform evaluation.

## Exchange / Teams / OneDrive / Defender (fixture-validated only)

- [x] Inbox rules (2026-10-16): `m365.set-inbox-rule` turns a rule off or back on (compensated) or removes it
      (`exchange/Set-InboxRuleState.ps1`, by RuleIdentity, `-Force`), wired as row actions on `m365.inbox-rules` 1.1;
      hidden rules (Exchange's own junk e-mail rule, or ones hidden through MAPI) are flagged and refused. Review fixes
      (1.0.1): a rule that forwards, forwards as attachment or redirects outside the accepted domains is never turned
      on — refused by the script, the playbook, and not offered on the audit (`m365.inbox-rules` 1.1.1).
- [ ] Live-run `m365.set-inbox-rule` on a visible rule: lookup, refusals and parameter binding are verified live, but no
      test mailbox has a visible rule and AdminForge can't create one (no mailbox for the validation user, no
      `New-InboxRule` path). Create one on AF-Test-Shared-02 in Outlook on the web (from an account with Full Access),
      then dry run → turn off → turn on → remove.
- [x] Send on Behalf (2026-10-16): `Set-MailboxPermission.ps1` adds and removes `GrantSendOnBehalfTo` entries (they hold
      the recipient's Name, often its Entra object id, so the read-back matches every name of the trustee);
      `m365.grant-mailbox-permission` / `m365.remove-mailbox-permission` 1.1 offer it and the Access tab can remove it.
      Verified live between the AF-Test shared mailboxes.
- [x] OneDrive access verified and removable (2026-10-16): `sharepoint/Set-SiteCollectionAdmin.ps1` adds, reads back
      and removes one site collection administrator through the tenant admin API (`GetSiteSecondaryAdministrators` /
      `SetSiteSecondaryAdministrators`), so no site-scoped connection is needed — a site-scoped one wouldn't work anyway:
      a SharePoint Administrator can't open other people's OneDrives. `m365.grant-onedrive-access` 1.1 reads the grant
      back and undoes it when SharePoint doesn't show it; `m365.remove-onedrive-access` takes the access away. Verified
      live on the AF-Test team's site; no test OneDrive exists (the test users are unlicensed).
- [ ] Live-run the OneDrive playbooks end to end once a licensed test user with a OneDrive exists. Today the refusals
      (no OneDrive, the owner, yourself) are verified live; `Set-SiteCollectionAdmin.ps1` now refuses team sites, so the
      earlier team-site check no longer applies. Watch the first real run: the script confirms the owner from their
      SharePoint profile (`PersonalUrl`, `msOnline-ObjectId` in `UserProfileProperties`) — Pester-validated only. If
      team sites are ever needed, add a separate, reviewed parameter rather than widening `siteUrl`.
- [ ] Teams PowerShell in read mode: since the runner stopped passing `-TenantId` with `-AccessTokens` (MicrosoftTeams 8
      answered "Not supported tenant type"), the connection works, but `Get-CsOnlineUser` fails inside the module's
      proxy ("GetSteppablePipeline … The expression after '&' … was not valid"), with real tokens only. Not caused by
      the read-mode guards (the module's private and internal cmdlets resolve under them offline). Debug with a real
      token in a worker (`m365.teams-user-policies`), then re-check the page.
- [ ] Graph Teams APIs (`/teams`, team settings, channels) answer delegated calls only for people with a Teams licence.
      Unlicensed admin accounts see an explanation on `m365.team`; consider reading team settings and channels with the
      automation identity's application permissions for them (`Team.ReadBasic.All`, `TeamSettings.Read.All`,
      `Channel.ReadBasic.All`), as `m365.teams-without-owners` already does for the archive state in schedules.
- [ ] SharePoint sharing: the tenant site list (`Get-PnPTenantSite`) returns no owner; rows of group-connected sites
      link to the group. Owners of other sites need `-Detailed` (one call per site) — add it as an option if wanted.
- [ ] `m365.teams-without-owners` counts owners in its transform: about 300 ms at 10,000 teams for ownerless teams and
      about 550 ms with "Include teams with one owner" (budget 250 ms). Large tenants need the transform off the event
      loop (see Platform) or a server-side `owners/$count` filter (advanced query; it counts apps too).
- [x] The executor's protected-object check matches object ids in a runner write's parameters: the mailbox, inbox-rule
      and OneDrive writes now pass the Entra object ids of every account they touch (`Set-MailboxForwarding`,
      `Set-MailboxPermission`, `Set-InboxRuleState`, `Set-SiteCollectionAdmin`), and the scripts refuse ids that don't
      match Exchange's `ExternalDirectoryObjectId` or the owner's SharePoint profile (review 2026-10-16).
- [ ] Clear forwarding has no automatic undo (by design: restoring a forwarding target should be a decision). The run
      output keeps the previous targets. `m365.set-mailbox-forwarding` 1.1 forwards only to user and shared mailboxes
      that don't forward on themselves, never to yourself, and needs a second engineer's approval (the person receiving
      the mail and the mailbox's owner can't approve); offboarding could offer "forward the leaver's mail to the
      manager" with it.
- [ ] Live-run the write of `m365.set-mailbox-forwarding` 1.1 after approval: it needs a second validation identity
      with `Playbook.Approver` (the validation user can't approve its own request). The preview, the approval gate and
      the refusals are verified live; the script's new checks are Pester-validated.
- [ ] `Set-MailboxPermission.ps1` reads a grant back for about 9 seconds; live, Full Access and Send As didn't show yet
      within that time (the run says so and the access was there a moment later). Consider a longer read-back.
- [ ] `m365.convert-to-shared-mailbox`: only the refusal path is verified live (the only user mailbox is the owner's).
      Convert a licensed test user's mailbox once one exists, then convert it back in the Exchange admin center.
- [ ] Distribution lists: `ManagedBy` comes back empty for the AF-Test list (created without an owner), so it counts as
      "Without an owner". Check a list with owners shows them by name (Exchange returns recipient Names, which can be
      object ids for newer recipients) and resolve them to display names if not. `AF-Test-DL-02`, created with an
      owner by `m365.create-distribution-list`, is the list to check this with.
- [ ] Live-validate the rest of the Exchange recipient playbooks. Done 2026-10-17: creating AF-Test-Shared-03,
      AF-Test-Room-01 and AF-Test-DL-02 (owner by mailbox address, engineer kept as owner) and an idempotent re-run of
      each; found that Exchange ignored `-AccountDisabled $false` (fixed in `m365.create-shared-mailbox` 1.1.0, sign-in
      through Graph — publish and re-check). Still open: the error texts for throttled / "matches multiple entries",
      the engineer stepping down (a list created without "Keep me as an owner"), and `m365.remove-created-recipient`.
- [x] Shared mailboxes page "Sign-in allowed" (done 2026-10-17): it read Exchange's `AccountDisabled`
      (`Get-MailboxSummary`), which still said blocked more than 20 minutes after Graph had enabled AF-Test-Shared-03's
      account (live; a fresh datasource cache key, so not the cache). The page (1.4) and the Shared mailboxes with
      sign-in allowed report (1.1) now take Entra's `accountEnabled` (getByIds by the mailboxes'
      `externalDirectoryObjectId`, 1,000 a call) and keep Exchange's state, labelled, only for accounts Entra didn't
      return. `check-accuracy.ts m365.shared` checks both against Graph.
- [ ] The "created by AdminForge" mark (`CustomAttribute15`) is a guard rail, not a boundary (SECURITY.md → Known
      gaps). Follow-up: before finishing or removing, check the recipient's object id against the output of
      AdminForge's own successful create run (runs store), and refuse marked recipients AdminForge has no run for.
      Consider an env key to choose which custom attribute holds the mark (one an organization doesn't already use).
- [ ] Re-creating an address while a removed mailbox is still soft-deleted (30 days): Exchange may refuse the address
      until the soft-deleted mailbox is purged or restored. Check live and, if so, say so in the create playbooks'
      availability check.
- [ ] Intune `managedDevices` `$filter`: the query-builder fields/operators on `endpoint.devices` (eq, OS version
      startsWith, date ranges, enrolment type, management state, encryption) follow Microsoft's documentation but are
      not live-validated (no Intune licence). Trim any Intune rejects.
- [x] Dropped 2026-10-17 with the Defender portal content (retired, see `docs/licensing-review.md`): the five items
      below. Reopen them only if that content comes back.
- [ ] ~~Defender device links (`security.microsoft.com/machines/v2/<id>/overview`) and CVE links~~: confirm the URL formats
      on a tenant with Defender for Endpoint. Still unverified (2026-10-16): the validation tenant has Office 365 E5
      only, and `security.device-vulnerabilities` is gated on `defenderEndpoint`.
- [ ] ~~Defender XDR live check~~: Defender XDR isn't set up in the validation tenant: Graph answers 403 "Account is not provisioned" for incidents,
      alerts and advanced hunting, although Office 365 E5 licenses them. After a Global Administrator opens
      security.microsoft.com once, live-check the following: `security.overview`, the incidents and alerts pages,
      `security.open-high-severity-incidents`, `security.alerts-summary` and their schedules, the two Defender probes,
      and hunting on EmailEvents in Query Studio. Then run `security.assign-incident` / `security.update-incident`
      (dry run → run → compensate) only on a test incident (for example from an attack-simulation or user-reported
      test message), never a real one.
- [ ] ~~`probes.risky-oauth-consents` source~~: it reads CloudAppEvents. Confirm whether Office 365 Cloud App Security (`ADALLOM_S_O365`,
      in Office 365 E5) fills it with consent events. If only Defender for Cloud Apps does, declare that licence on the
      probe.
- [ ] ~~Narrow the `defender` plan list~~: `defender` lists `ATP_ENTERPRISE` (Defender for Office 365 Plan 1). Plan 1 alone probably doesn't give Defender
      XDR incidents or advanced hunting: confirm on a Plan 1 tenant and narrow the plan list.
- [ ] ~~Email threats report~~ (Defender for Office 365 Plan 2, licensed now): build a report on EmailEvents /
      EmailPostDeliveryEvents (phish and malware delivered, ZAP results, user-reported messages) once hunting works in
      the tenant.
- [x] The leaver runbook (`identity.leaver` 1.2) no longer lists the mailbox and OneDrive tasks as manual: step 3 says
      what Offboard user does with them, an optional automatic reply is passed to it, and section 5 keeps only what the
      offboarding run reports as not done and the tasks outside Microsoft 365. 1.2.1 declares what Offboard user needs
      (Exchange, SharePoint admin, License / Groups / Exchange Recipient / SharePoint Administrator), with a test.
- [x] `identity.compromised-account` 2.0.1 points its containment step at the inbox rule audit (turn off / remove
      rules), the mailbox page and Clear forwarding instead of a manual "remove inbox rules and forwarding" item.
- [ ] Scheduled (automation) inbox-rule scans need app-only Exchange in the runner (see Engine & runner).

## Entra ID P1/P2 and Intune (plan Phase 2 validation, 2026-10-16)

- [x] `identity.sign-in` 1.1.0: `GET /auditLogs/signIns/{id}` took ~165 s and failed, so the inspector never showed
      the sign-in; the page filters the list on the id, bounded to ±5 min of the sign-in's time (`at`, passed by the
      sign-ins, user and enterprise app pages): ~1–2 s, found or not. Without `at` (old links) it searches the last
      7 days — a missing id took ~9 s over 7 days and timed out over 30 (measured 2026-10-16). A sign-in that isn't
      found says so (header, note, no actions) and is cached 5 minutes, not an hour.
- [x] `endpoint.apps` 1.0.1: `isAssigned` doesn't exist on v1.0 `mobileApp`; assignment state comes from `assignments`.
- [x] Risky-user lookups (`security.dismiss-risky-user` 1.1.0, `security.confirm-risky-user-compromised` 1.1.0, both
      compromised-account runbooks) filter `riskyUsers` instead of reading `riskyUsers/{id}`, which is a 404 without a
      readable message for a user who was never at risk.
- [ ] Identity Protection writes can't be validated live: the validation user has no Security Operator. Option: make it
      PIM-eligible for Security Operator (a test fixture) and activate it in the live suite before confirm/dismiss on
      AF-Test-User-03 — owner's decision (it raises the tester's reachable privilege).
- [ ] Platform: a playbook's `requires.entraRoles` isn't checked before the run, so a person without the role gets
      Graph's "Signed in user is missing required roles" as the step error. Check it in the preview (or at least map the
      403 to a hint naming the declared role).
- [ ] Platform: Graph errors with an empty message show as "UnknownError: Microsoft returned an error without a
      readable description"; a 404 should say the object wasn't found (e.g. `security.risky-user` opened for a user
      with no risk record).
- [ ] PIM: no playbook to deactivate an activated role (`selfDeactivate`); activations only expire.
- [ ] Dynamic groups: add a dynamic `AF-Test-Dynamic-01` test fixture (and a delete-group playbook, or provisioning
      cleanup) so `identity.edit-dynamic-rule` and dynamic `identity.create-group` can be run for real.
- [ ] Re-check the `userRegistrationDetails` pages and reports (authentication methods registration, users without
      MFA, the users page MFA filter) once Microsoft fills the report in (24–48 h after licensing).
- [ ] Intune device pages and device actions (sync, restart, retire, wipe) need an enrolled `AF-Test-*` device (plan
      0.4).
- [ ] Live tooling: for ~10 minutes after `provision test-identities --enable` every Graph call can answer `reauth`
      (Continuous Access Evaluation still applies the session revocation from `--disable`), and the session then fails
      CSRF. The live scripts should recognise it and say "wait a few minutes after enabling", or retry.

## Content at enterprise scale, second round (2026-10-17)

- [x] Native rewrites (`$applyAdvanced`, `$withFields`, native sort and grouping) that now meet their perf budgets at
      enterprise scale: `endpoint.os-versions`, `endpoint.device-security-gaps`, `endpoint.non-compliant-devices`,
      `endpoint.stale-devices`, `endpoint.autopilot-not-enrolled` (2.0.0), `endpoint.apps` (2.0.0), `identity.inactive-guests`
      (2.0.0), `identity.directory-changes` (2.0.0: figures over every event, the newest 500 described),
      `identity.app-credential-expiry` (1.2.0: the first 400 apps with a credential in the window, ending within 7 days first),
      `m365.message-center-actions` (2.0.0), `security.risky-users-review` (2.0.0: detections looked up for the first
      1,000 listed).
- [x] `identity.app-registration-risks` 2.0.1 runs every finding in one native pass (`$idsWhere`, `containsAny`-style
      operators), checks plain HTTP per URI only for apps with an http:// URI and builds flags and severities natively
      (`$flagIn`) — ~400 ms → ~250 ms at 20k apps with two thirds flagged (the synthetic tenant's extreme). It reads
      15,000 apps (partial note above that) and `identity.password-policies` 2.0.1 40,000 members, so both fit the
      250 ms budget on a cold run; the weekly schedules run within budget again. 2.0.2 checks critical permissions as
      before 2.0 again (a critical app role id and an application permission, `type: Role`, requested). After the
      security review the helpers check the budget while building sets and compiling filters and by work done (rows ×
      conditions, `$applyAdvanced` too), cap a filter at 64 conditions, `containsAny`-style texts at 256 characters
      and `$flagIn` at 1,000,000 values across its sets, and take only texts, numbers and true/false as ids.
- [ ] Lift those two caps: a per-tenant snapshot (precomputed by the automation identity, as above) or transforms off
      the event loop with a larger budget for reports and exports — the evaluation is near its floor (set lookups and
      row copies, ~1 µs per row per finding).
- [ ] The 250 ms transform budget is wall-clock, so a small transform can run out of it while another request holds
      the event loop: garbage collection and response reading after a large crawl (inactive guests, identity health at
      100k users) stall it for 250–600 ms. In the load test that failed 0–3 of 1,300–4,300 datasources at 50 engineers
      and up to 8 of 8,400 at 200 (`content_error`; measured before a timed-out transform ran once more before failing). Count only the
      transform's own time, or run transforms off the event loop (above). `tests/perf/load.ts` lists the stalls and
      the datasources that failed.
- [ ] Beyond the design target (~50 engineers at once): one API process with 48 slots makes ~65–90 Graph calls a
      second of the default mix; above that the first call of a datasource waits the whole `OUTBOUND_QUEUE_WAIT_MS`
      (FIFO, so p50 sits at 15 s) and the rest is refused (performance.md → Beyond the design target). If usage ever
      gets there: more slots or processes within the Read app's Graph budget, and shed load early under a standing
      queue (newest first / a shorter wait) instead of making every request wait 15 s.
- [ ] Exports still capped by a transform (JSONata per row), stated on the page and in the schedule summaries:
      `identity.directory-changes` (newest 500 events), `security.risky-users-review` (1,000 users),
      `identity.app-credential-expiry` (400 apps). The third round's `$unnest` / `$attach` can now lift them.
- [x] Over the transform budget at enterprise scale in this round, reworked in the third round (below):
      `identity.app-credential-hygiene#credentials`, `identity.app-permissions#holders`,
      `identity.apps-without-owners#report`, `identity.consent-grants#objects`,
      `identity.disabled-users-with-licences#users`, `identity.privileged-role-assignments#assignments`,
      `identity.users-without-mfa#report`.
- [ ] Grouping keys must be text: a native grouping throws on a `null` key (missing keys are skipped). The rewritten
      reports group only rows that have the key; check other content that groups on optional fields.

## Content at enterprise scale, third round (2026-10-17)

- [x] Native rewrites with the new row helpers (`$pluck`, `$unnest`, `$attach`, `$pick`, `$withCount`, date `days`
      shift in `$applyAdvanced`) that now meet their perf budgets: `identity.app-permissions` (2.0.0: `permissionList`
      for the export, the page shows 2,000), `identity.consent-grants` (2.0.0: `grantList` / 2,000 on the page),
      `identity.app-credential-hygiene` (2.0.0: `secrets`, `page` labels the first 2,000, `exportList` has every
      flagged credential), `identity.apps-without-owners`, `identity.users-without-mfa`,
      `identity.disabled-users-with-licences`, `identity.privileged-role-assignments` (all 2.0.0).
- [ ] The full lists pass but take 250–460 ms end to end at enterprise scale (`tests/perf/budgets.json` `knownSlow`,
      `mayTimeOut`): `identity.app-permissions#permissionList`, `identity.consent-grants#grantList`,
      `identity.app-credential-hygiene#secrets` / `#page` / `#exportList`. Most of it is the engine copying rows into
      and out of each datasource (`plain()`), outside the expression budget. The page views
      (`app-permissions#permissions`, `consent-grants#report`) are built from those lists, so every page load pays for
      the full list; the hygiene `secrets` and `page` sit on the page path and may time out on a busy host. A
      copy-free hand-over between datasources would bring them under the page budget.
- [ ] Derived datasources don't carry `truncated`: the four reports pass their reads' flag on as `partial` with a
      "Partial read" note on the page, but an export of `permissionList` / `grantList` / `exportList` can't say it
      was cut. The engine should pass `truncated` through derived datasources so exports can flag it.

## Live accuracy (2026-10-17)

First run of `tests/live/scripts/check-accuracy.ts` against the host services (docs/enterprise-scenarios.md).

- [ ] `identity.group#owners` misses service-principal owners. Graph v1.0 `GET /groups/{id}/owners` (the datasource's
      request) returned only the people for AF-Test-M365-01 (1 of 2 owners) and nothing for AF-Test-M365-02 (0 of 1),
      while the page's own owner KPI (`memberCount.owners`, `owners/$count`) says 2 and 1 — the owners table and the KPI
      disagree on the same page. The missing owner is the app (provisioner service principal) that created these
      Microsoft 365 groups with application permissions; `/owners/microsoft.graph.servicePrincipal` (v1.0) and beta
      `/owners` return it. Fix: read `/owners/microsoft.graph.user` and `/owners/microsoft.graph.servicePrincipal` (a
      graphBatch) and keep `ownerType`; bump the page.
- [ ] `identity.groups-without-owners#report` counts an app as an owner (`$filter=owners/$count eq 0`), so a group owned
      only by a service principal (AF-Test-M365-02) is not reported, though no person can manage it. Decide whether "no
      owner" means no person; if so, add a "no person owner" check (the user cast) and say so in the report.
- [ ] Fixture `directory` (Phase F): AF-Test-M365-02 is meant to have no owner, but Graph keeps the provisioner's
      service principal as owner of Microsoft 365 groups it creates (AF-Test-M365-01 has it too, beside AF-Test-User-04).
      Remove the provisioner's owner reference after creating the group (keep the catalogue's people), or model the app
      owner in the catalogue. check-accuracy.ts reports it as a documented difference until then.
- [ ] AF-Test-SignIn-01's successful sign-in (scripts/generate-sign-ins.ts) is not in the sign-in logs about an hour
      later — v1.0 and beta, interactive and non-interactive — while AF-Test-SignIn-02's eight attempts are (50126 wrong
      password, 50072 MFA registration required, 50057 disabled). Re-run check-accuracy.ts later (Microsoft can take
      up to about two hours); if still missing, check that the script's success path really completes an Entra
      sign-in for that account.
- [ ] Re-run check-accuracy.ts after the Phase E reports are published (`identity.user-attribute-completeness`,
      `identity.saml-certificate-expiry`, `identity.licence-assignment-errors` showed as not published) and after the
      registration report catches up (8 of 12 members after a day; Microsoft refreshes it every few hours).

## Synthetic monitoring of Microsoft 365 (2026-10-17)

- [ ] Run the synthetic transactions live once their test objects exist (mail flow, SharePoint file round trip, Teams
      meeting; `provision entra` grants Sites.Selected). Only the read-only checks were validated live so far.
- [ ] A per-permission opt-in for application write permissions: `OnlineMeetings.ReadWrite.All` (Teams meeting check)
      needs `AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS`, which lifts the ceiling for every write permission content
      declares. Until then, run the transactions sweep as a dedicated named identity (ADR-014).
- [ ] `provision status`: warn when the identity holds a site grant other than `write` on `AF_SYNTHETIC_SITE_ID`
      (`fullcontrol` could manage the site's permissions) — grants made in SharePoint are invisible to it today.
- [ ] Message center filters (`m365.message-center`, `m365.message-center-actions`) still offer "OneDrive for
      Business"; service health now says "Microsoft OneDrive" — check which name Message center posts use.
- [ ] Provision the test objects with the CLI (an `AF_TEST_FIXTURES=synthetic` fixture: shared test mailbox and its
      Exchange RBAC scope, test site and its Sites.Selected grant, the Teams application access policy) instead of the
      manual steps in docs/operations.md › Synthetic transactions.
- [ ] Mail flow to and from the internet (an external mailbox that echoes) and a message trace (Get-MessageTraceV2, or
      Graph message trace when it is generally available) to say where a late message is waiting.
- [ ] More transactions: a OneDrive round trip in the test user's OneDrive; a Teams chat or channel message read back
      (app-only can't post messages — needs a bot or a delegated test account); a calendar invitation accepted.
- [ ] `probes.teams-web-client` sends a current Edge user agent so Teams serves its web app; refresh it if Microsoft
      changes the browser check (the probe then sees the "unsupported browser" redirect and fails).
- [ ] The per-workload sign-in probes need 20 sign-ins an hour to judge; small tenants stay "insufficient data". Tune
      `minSignIns` per installation if that's too quiet.
- [ ] The e2e navigation mock (`tests/support/web/fixtures`) still has the single Microsoft 365 section; update it
      (and its screenshot baselines) to the per-workload parents and Azure Billing.

## Azure Billing (2026-10-17)

- [ ] **Validate live** once the tenant has a subscription with cost: every view once, read-only, against a management
      group and a single subscription, and the billing-account scope and Invoices with a billing role. Fixture-only
      so far: the Cost Management column names (`BillingMonth` for monthly granularity, `TagKey`/`TagValue`, empty
      values for untagged cost), the forecast's `CostStatus`, the invoice fields and status values, and whether the
      invoices API still wants `periodStartDate`/`periodEndDate`.
- [ ] Give the automation identity Cost Management Reader on the cost management group from `provision entra` (today
      it is assigned by hand; provisioning grants Reader on `AF_SUBSCRIPTION_ID` only).
- [ ] A management-group picker (an entity picker kind `managementGroup`): the scope is configuration
      (`AF_COST_MANAGEMENT_GROUP_ID`) or a deep link (`?managementGroupId=`) today.
- [ ] Budgets across subscriptions: `azure.budgets` reads one subscription; a fan-out over the subscriptions (or the
      management-group budgets API for EA) would list them all.
- [ ] Reservation and savings-plan utilisation and recommendations (`Microsoft.CostManagement/benefitUtilizationSummaries`,
      `benefitRecommendations`) — amortized cost and the pricing-model grouping cover where the cost lands.
- [ ] Cost anomaly alerts (Cost Management scheduled actions) and a "daily cost jumped" probe.
- [ ] Invoice PDF download: `POST …/invoices/{name}/download` changes nothing but is a POST, so the read policy refuses
      it; the page links to the Azure portal instead.
- [ ] Large estates: Cost Management answers one page per query here (`properties.nextLink` is reported as partial,
      not followed). Within one answer every row is totalled and exported (`$tableRows`); the pages list the 500
      highest. Following `nextLink` in the ARM connector for Cost Management POSTs would complete answers over 5,000
      rows.
- [ ] A finance-only portal role (today finance users get `Portal.Reader` and see every section, with what their own
      account can't read explained).
- [ ] Names that repeat: grouping by subscription or resource group **name** adds up same-named ones across the
      estate (`rg-network` in every subscription). Pair the id with the name (as the overview and this-month-and-last
      do for subscriptions), or group resource groups by subscription too at management-group scope.
- [ ] Billing-scope groupings: billing profile and invoice section (MCA), department and enrollment account (EA) —
      the policy already allows the billing-profile query scope; no view uses it yet.
- [ ] A named past month for chargeback, top resources and this-month-and-last (re-running August's close), and the
      covered month in scheduled file names (today the file is named by run date and labelled "Last month").
- [ ] Mixed currencies: totals across billing accounts in different currencies add them as they are (the views say
      so); split totals by currency instead.
- [ ] Mock-mode fixtures: no subscription-scope forecast, no billing-account-scope query, and the subscription query
      fixture answers resource-group columns for every grouping.
- [ ] Check live whether a throttled Cost Management query sends a standard `Retry-After` or only its
      `x-ms-ratelimit-microsoft.costmanagement-*` headers (the connectors honour `Retry-After`).
- [ ] Scheduled finance files are visible to Operators only (scheduled data rule); finance users with
      `Portal.Reader` get the email but can't browse the archive. Decide whether billing schedules widen
      `requires.portalRoles`.

## Hybrid Azure Arc servers (2026-10-17)

- [x] **Function Apps and Arc Kubernetes retired 2026-10-17** (not needed at this time; the estate will be AVD and
      thousands of hybrid Arc servers). Retired, kept for run and audit history: `azure.function-apps`,
      `azure.function-app`, `azure.function-apps-without-auth` with `reports.function-apps-without-auth-weekly` (also
      turned off), `azure.function-app-incident-triage`, `azure.sync-function-triggers`, `probes.function-hr-sync-health`,
      `integrations.hr-sync` and `azure.arc-kubernetes`. **To bring them back:** set each to `status: active` with a
      version bump (the schedule also `enabled: true`), put the links back on `azure.overview` (KPI "Function Apps
      stopped" and the "Where to next" links) and `azure.resource` ("Open Function App view" on `microsoft.web/sites`),
      restore the Log Analytics "Function App errors" query (`azure.log-analytics` 1.0.1), and drop them from the
      retired list in `tests/content/arc-fleet.test.ts`. Restart, start and stop (`azure.restart-app`, `start-app`,
      `stop-app`) stay active for App Service web apps; the App Service security report still covers Function Apps.
- [ ] **Validate live** once a subscription has Arc servers: every Arc view, the server page's Updates and Defender
      tabs and the five Arc probes, read-only. Fixture-only so far: the Update Manager record types (summary = types
      without `softwarepatches`), the assessment `status` / `errorDetails` fields, `kbId` / `classifications` on
      per-update records, `licenseProfile.esuProfile` in Resource Graph, the Defender assessment ids under a machine,
      and `arg_max` with several columns in a join subquery.
- [ ] Agent currency from Microsoft's latest release: Advisor's "Upgrade to the latest version of the Azure Connected
      Machine agent" recommendation (`advisorresources`, `extendedProperties.latestVersion`) instead of the newest
      version in the fleet (wrong when every server is behind).
- [ ] Defender for Servers enabled per machine (resource-level pricing) and servers onboarded to Defender for Endpoint
      without the MDE extension: both show as gaps today.
- [ ] ESU licences (`microsoft.hybridcompute/licenses`: cores, edition, state) and which servers each one covers.
- [ ] A weekly patch-compliance report and schedule from `azure.arc-patching` (overdue, failed installs, not assessed)
      for the change board; the page exports it today.
- [ ] Physical site: Arc's `properties.locationData` (name, city, country) as a fleet chart and filter, if the
      servers are onboarded with it (the fleet charts use the Azure region today).

## Azure Virtual Desktop (2026-10-17)

- [ ] **Validate live** once a subscription has a host pool: every AVD view, the four reports and five probes
      read-only, then the three playbooks on a test host pool (dry run, run, undo). Fixture-only so far: the
      `desktopvirtualizationresources` session host properties in Resource Graph (and how soon they follow a status
      change), `mv-expand` of the health check results inside a join, the user session `$filter` syntax, the
      `force=true` log off, and the WVD table columns.
- [ ] Disconnect a session (`POST …/userSessions/{id}/disconnect`) as its own playbook: today an engineer sends a
      message or signs the user out.
- [ ] How long a host has been in drain mode: Azure keeps no timestamp for `allowNewSession`. The Activity Log
      (`AzureActivity`, `MICROSOFT.DESKTOPVIRTUALIZATION/HOSTPOOLS/SESSIONHOSTS/WRITE`) could date it, so the drain mode
      report could flag hosts drained for more than a day; today it lists every drained host.
- [ ] Find a person's sessions across every host pool in one search: Resource Manager lists sessions per host pool
      (one call each). Today: Connections (Log Analytics) shows where they connected, then User sessions for that pool.
- [ ] Start, restart or deallocate a session host's virtual machine (or Arc machine) from the session host page.
- [ ] Capacity thresholds per host pool (the nearly-full check uses 90 % for every pool) and connection-failure
      thresholds sized to the installation (10 / 50 failed connections an hour today).
- [ ] FSLogix profile health and logon duration (`WVDCheckpoints`, Windows event logs) — not read yet.
- [ ] Scaling plan schedules, registration tokens and adding session hosts stay in the Azure portal.

## Navigation / product

- [ ] Decide between the content "Probe dashboard" (`automation.monitoring`, nav: Automation) and the coded
      `/monitoring` page ("Synthetic monitoring", nav: Overview): both are still in navigation. Keep one.
- [x] Merge `security.compromised-account-response` into `identity.compromised-account` 2.0.0; the old runbook is
      retired (`status: retired`, 1.1.0) and out of navigation.
- [x] Weekly schedule for the `identity.inactive-users` report (`reports.inactive-users-weekly`).
- [ ] `identity.disable-user` typed confirmation asks for the UPN; for guests that is the `…#EXT#@…onmicrosoft.com` form (the "Block sign-in" action on `identity.inactive-guests`). Consider confirming guests on `mail`.

## News and changes

- [ ] Service health has no documented per-issue link in the Microsoft 365 admin center: items cite the service
      health page and show the issue id. Switch to a deep link if Microsoft documents one.
- [ ] MSRC's JSON API (`api.msrc.microsoft.com/sug/v2.0/…`) carries product family, severity, exploited and
      customer-action flags, but is undocumented; the documented RSS feed is used (severity stays normal, so CVEs
      don't flood Breaking). Revisit if Microsoft documents the API.
- [ ] The Microsoft Graph changelog has had no new items since August 2026 (`quietAfterDays: 45` flags it); the Learn
      "What's new in Microsoft Graph" feed is the live signal. Retire `feeds.graph-changelog` if it stays quiet.
- [ ] Learn what's-new feeds only say "this page was updated" (Learn search RSS has no per-change items). A per-change
      feed would need parsing the page, which the terms and the plain-text rule rule out.
- [ ] News areas still say `m365` for Exchange Online, SharePoint Online and Teams items, although navigation (and
      the Reports catalogue) now has a parent per workload. Split `NEWS_AREAS` (`schemas/news.ts`) into `exchange`,
      `sharepoint`, `teams` with feed rules by Message center / service health `service`, keep `m365` for the suite,
      and decide what stored items with `m365` become (re-classify on the next collection, or keep).
- [ ] Teams/email digest of breaking items (daily, to `AF_…ALERTS` recipients) through the existing delivery path.
- [ ] Azure Advisor service-retirement recommendations (`advisorresources`) as a tenant feed: retirements that affect
      resources you actually have.
- [ ] The Microsoft 365 Roadmap feed doesn't drop items for government clouds only (GCC, GCC High, DoD): a rule can't
      express "every listed cloud is non-worldwide". Add a generic "only when all categories are in …" match if needed.
- [ ] Message Center: data-privacy posts are Portal.Admin only because Graph doesn't document whether application
      reads return them; confirm against a tenant with such a post.
- [ ] HTTP probes still check the resolved address before connecting rather than pinning it; adopt the news feeds'
      pinned dispatcher (`news/fetch-feed.ts`) for `http` probes too.
- [ ] Connector retry waits (`connectors/src/types.ts` `defaultSleep`) don't listen to the abort signal, so a feed's
      timeout can't cut a `Retry-After` wait short; collection order and the run budget limit the effect for now.
- [ ] `news.updated` events carry counts over all items, including ones a reader may not see (counts only, no content).
