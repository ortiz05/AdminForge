# AdminForge backlog

Gaps found while building. Each item names where it lands. Items move to a phase plan when scheduled.

## Security (before write playbooks go live)
- [ ] **Secret outputs**: temporary passwords, Temporary Access Passes and new app secrets are currently kept in step/run outputs. Add `secret: true` on step outputs → shown once to the initiator over the live stream, never persisted (store a redacted marker), never in audit/export. Applies to identity.reset-password, identity.issue-tap, identity.create-user, identity.rotate-app-secret.
- [ ] `$secureRandom(len)` helper (crypto-backed) — `create-user` currently uses JSONata `$random()` for a throwaway initial password.

## Schema / content model
- [ ] Licence state in the expression scope (`licences.signInLogs`) so a page can drop P1-only `$select` fields instead of gating the whole page (users list + signInActivity).
- [ ] `graphBatch` paging (`@odata.nextLink` per sub-request).
- [ ] Per-row `inspect.page` expression (mixed row types).
- [ ] Playbook `tests` can set `now` and `env`.
- [ ] Column kind naming: align `id` (docs/widgets.md) vs `guid` (schema) — accept both.
- [ ] `widgets.md`: document `timeline.heading`, `empty.action` with playbook inputs.
- [ ] Probe schedules: `job.refs` (list) or a tag selector (`job.select: { tags: [hourly] }`) so one schedule sweeps many probes (today: one schedule per probe).
- [ ] ARM `apiVersion` from an expression or a per-resource-type lookup, enabling a generic "get resource by id".
- [ ] Expression helpers `$kql(s)` (KQL string literal quoting — R12) and `$uuid()` (fresh GUID, e.g. role assignment names).
- [ ] Datasource fan-out (one call per row of another datasource) and simple joins.
- [ ] `logQuery` widget + Query Studio page (`/query`) with save-as report/probe/schedule — R12.
- [ ] `kql` probe/check kind over Resource Graph, Log Analytics, advanced hunting — R12.
- [ ] Licence-threshold probe `sku` from `${env.X}` so SKUs aren't literals.
- [ ] Approval policy for bulk runs: one approval for the whole bulk run (today each child run asks).
- [ ] `POST /api/runs/:id/input/:stepId` for input steps (today manual steps accept `values`).

## Delivery & notifications
- [ ] Report delivery by email and Teams: config keys (`AF_REPORT_RECIPIENTS`, `AF_TEAMS_WEBHOOK_URL`) and schedule `delivery` support.
- [ ] Notify approvers when an approval gate opens (approver list in the NOTIFY payload + email/Teams).

## Engine & runner
- [ ] `http` step host allowlist (config `AF_HTTP_ALLOWED_HOSTS`); today `http` steps fail with `http_not_supported`.
- [ ] PowerShell steps for scheduled (automation) runs: app-only Exchange/Teams/PnP via certificate auth in the runner.
- [ ] Runner HMAC already binds method + path; consider mTLS if the runner ever leaves loopback.

## Platform
- [ ] Read-mode allowlist: Graph `POST /directoryObjects/getByIds`; ARM `…/config/appsettings/list` with values stripped server-side.
- [ ] Example connection `connections/hr-sync`: env keys for base URL + audience.
- [ ] Default Log Analytics workspace key (`AF_LOG_ANALYTICS_WORKSPACE_ID`).

## Navigation / product
- [ ] Decide between the content "Probe dashboard" and the coded `/monitoring` page (keep one entry in nav).
- [ ] Merge `security.compromised-account-response` and `identity.compromised-account` runbooks.
- [ ] Weekly inactive-users schedule once `identity.inactive-users` report exists.
