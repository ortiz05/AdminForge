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
- [ ] `provision status` checks the validation user's active and group-held directory roles, not PIM-eligible ones
      (`roleEligibilitySchedules`, needs Entra ID P2): an eligible role could be activated with its stored password.
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
- [ ] Content: merge `identity.licence-utilization` and `m365.licence-utilization`; one SKU-name map (three YAML copies
      and `web/src/lib/overview.ts`); one spelling of utilisation; `reports.app-credential-expiry` → a cadence suffix.
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
- [ ] Enable `reports.azure-monthly-cost-weekly` once the automation identity's access to Cost Management is
      confirmed (Reader may be enough; Cost Management Reader otherwise).
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
- [x] Tenant-data guard and the CLI's fixture recording (now one rule: `tenantValues` in `@adminforge/config`) exempt `https?://localhost.*`, which also lets `http://localhost.<domain>` through; anchor it to `localhost(:port)/?` in both places.
- [x] Enforce formatting: Prettier (repo formatted once) is checked in CI (`pnpm format:check`) and applied by the Claude Code after-edit hook; the pre-commit hook runs only the guard tests. `portal/content`, fixtures and `docs/plans` are excluded (`.prettierignore`).
- [x] Read-mode allowlist: Graph `POST /directoryObjects/getByIds`; ARM `…/config/appsettings/list` with values stripped server-side (names only; the read is audited).
- [ ] Example connection `connections/hr-sync`: env keys for base URL + audience.
- [x] Default Log Analytics workspace key (`AF_LOG_ANALYTICS_WORKSPACE_ID`).

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
      object ids for newer recipients) and resolve them to display names if not.
- [ ] Intune `managedDevices` `$filter`: the query-builder fields/operators on `endpoint.devices` (eq, OS version
      startsWith, date ranges, enrolment type, management state, encryption) follow Microsoft's documentation but are
      not live-validated (no Intune licence). Trim any Intune rejects.
- [ ] Defender device links (`security.microsoft.com/machines/v2/<id>/overview`) and CVE links: confirm the URL formats
      on a tenant with Defender for Endpoint. Still unverified (2026-10-16): the validation tenant has Office 365 E5
      only, and `security.device-vulnerabilities` is gated on `defenderEndpoint`.
- [ ] Defender XDR isn't set up in the validation tenant: Graph answers 403 "Account is not provisioned" for incidents,
      alerts and advanced hunting, although Office 365 E5 licenses them. After a Global Administrator opens
      security.microsoft.com once, live-check the following: `security.overview`, the incidents and alerts pages,
      `security.open-high-severity-incidents`, `security.alerts-summary` and their schedules, the two Defender probes,
      and hunting on EmailEvents in Query Studio. Then run `security.assign-incident` / `security.update-incident`
      (dry run → run → compensate) only on a test incident (for example from an attack-simulation or user-reported
      test message), never a real one.
- [ ] `probes.risky-oauth-consents` reads CloudAppEvents. Confirm whether Office 365 Cloud App Security (`ADALLOM_S_O365`,
      in Office 365 E5) fills it with consent events. If only Defender for Cloud Apps does, declare that licence on the
      probe.
- [ ] `defender` lists `ATP_ENTERPRISE` (Defender for Office 365 Plan 1). Plan 1 alone probably doesn't give Defender
      XDR incidents or advanced hunting: confirm on a Plan 1 tenant and narrow the plan list.
- [ ] Email threats (Defender for Office 365 Plan 2, licensed now): build a report on EmailEvents /
      EmailPostDeliveryEvents (phish and malware delivered, ZAP results, user-reported messages) once hunting works in
      the tenant.
- [x] The leaver runbook (`identity.leaver` 1.2) no longer lists the mailbox and OneDrive tasks as manual: step 3 says
      what Offboard user does with them, an optional automatic reply is passed to it, and section 5 keeps only what the
      offboarding run reports as not done and the tasks outside Microsoft 365. 1.2.1 declares what Offboard user needs
      (Exchange, SharePoint admin, License / Groups / Exchange Recipient / SharePoint Administrator), with a test.
- [x] `identity.compromised-account` 2.0.1 points its containment step at the inbox rule audit (turn off / remove
      rules), the mailbox page and Clear forwarding instead of a manual "remove inbox rules and forwarding" item.
- [ ] Scheduled (automation) inbox-rule scans need app-only Exchange in the runner (see Engine & runner).

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
