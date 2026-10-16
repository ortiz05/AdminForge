# Microsoft 365 E5: unlock the licence-gated features, and keep the tooling modular

Plan, 2026-10-16. Owner decision that started it: the validation tenant now has Microsoft 365 E5, so every feature
AdminForge gated on Entra ID P1/P2, Intune or Defender for Endpoint should work — accurately, not just unlocked — and
every utility, script and tool should be organised so it can be maintained on its own.

## Where we start

- **Nothing is locked any more.** The licence gate reads the tenant's service plans: with Microsoft 365 E5 every feature
  key (`signInLogs`, `conditionalAccess`, `pim`, `identityProtection`, `intune`, `defenderEndpoint`, plus Exchange,
  Teams, SharePoint, Defender) is available, and the navigation shows no "Requires …" badge.
- **Unlocked is not the same as working.** The Office 365 E5 round (Exchange, Teams, SharePoint/OneDrive, Defender for
  Office 365) found about twenty defects that only showed against a real tenant — wrong response shapes, a datasource
  that never ran, Microsoft refusals with misleading messages, and one production-only bug (published definitions lost
  their key order). The newly unlocked areas have only ever run against synthetic fixtures; expect the same.
- **Permissions are already in place.** `adminforge validate --scopes` reports every scope content declares as granted;
  two automation permissions are unused and can go (see Phase 4).
- **Content in scope** (licence key → definitions):

  | Licence feature                                   | Definitions | Examples                                                                                         |
  | ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
  | `signInLogs` (Entra ID P1)                         | 15          | sign-in pages, user page, inactive users/guests, users without MFA, sign-in health probes        |
  | `conditionalAccess` (Entra ID P1)                  | 4           | Conditional Access policies, policy page, named locations, identity health dashboard             |
  | `AAD_PREMIUM` (Entra ID P1)                        | 1           | edit dynamic membership rule                                                                     |
  | `pim` (Entra ID P2)                                | 6           | PIM page, role page, privileged role assignments, add/remove eligibility, activate               |
  | `identityProtection` (Entra ID P2)                 | 9           | risky users and user page, confirm compromised / dismiss, compromised-account runbook            |
  | `intune` (Intune Plan 1)                           | 24          | devices and device page, compliance, configuration, apps, Autopilot, six reports, device actions |
  | `defenderEndpoint` (Defender for Endpoint Plan 2)  | 1           | device vulnerabilities (plus hunting on device tables, device links)                             |

  Plus the schedules and probes built on them (inactive users/guests, users without MFA, risky users review, the six
  endpoint reports, sign-in health probes).

## How we work (same rules as the Office 365 E5 round)

- Live validation as the validation user against the dev stack (content hot reload, dev database), then on the host.
- Writes only on `AF-Test-*` objects that provisioning created: dry run → run → reverse. Never on a person or a real
  device. Device wipe/retire are verified as dry runs and refusals only, unless a dedicated test device exists.
- Reports are counts and statuses; nothing tenant-specific in the repository (fixtures stay synthetic, with the real
  response shapes).
- Each area ships complete: content and code fixes, tests (new files), fixtures, docs (`docs/licensing-review.md`,
  `docs/backlog.md`, skills), security and content review before commit, publish after review.

## Phase 0 — prerequisites only the owner can do

| #   | Action                                                                                                                                   | Unblocks                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0.1 | Assign Microsoft 365 E5 to every real person who needs it — when moving from another subscription, assign the new licence before removing the old one, and make sure nobody is left unlicensed when the old one lapses | Keeps their mailbox and OneDrive; Teams for them                       |
| 0.2 | Sign in once to the Microsoft Defender portal (security.microsoft.com) as Global or Security Administrator                                | Defender XDR data provisioning (incidents, alerts, hunting) and Defender for Endpoint onboarding |
| 0.3 | Decide **Security Defaults vs Conditional Access**: Conditional Access policies can't be created while Security Defaults is on. Either keep Security Defaults (CA pages are validated read-only against an empty policy list) or switch to a Conditional Access baseline (require MFA for admins and all users, block legacy authentication) and turn Security Defaults off | Validating the CA pages against real policies, report-only test policy |
| 0.4 | Enrol one test Windows device (a VM is fine) into Intune and onboard it to Defender for Endpoint, named `AF-Test-*`                        | Device pages, compliance state, device actions, vulnerabilities         |
| 0.5 | Allow test identities to consume E5 seats (the validation user and AF-Test-User-01..03: four seats)                                      | Licensed test mailboxes, OneDrives, Teams, PIM activation for the tester |
| 0.6 | Rotate the provisioner secret (it was shared in chat) and remove the provisioner's admin role between provisioning runs                  | Security hygiene                                                       |

## Phase 1 — licensed test fixtures, as provisioning (not one-off scripts)

Extend `pnpm adminforge provision test-identities` (plan → apply → `provision status` ✓/✗, test labels only, objects it
created only) with an opt-in **licensed fixtures** section:

1. **Licences:** assign `AF_TEST_LICENCE_SKU` (e.g. `SPE_E5`) to the validation user and AF-Test-User-01..03 when set;
   status shows seats used. Gives the test users mailboxes and OneDrives (end-to-end tests for convert-to-shared,
   OneDrive handover, inbox rules on a real mailbox) and lets the tester see Teams settings and activate PIM.
2. **PIM:** AF-Test-User-01 eligible (not active) for a low-privilege role (e.g. Reports Reader); the validation user
   eligible for a role it can activate in the live suite. Status reads eligible assignments (closes the backlog item
   "provision status checks … not PIM-eligible ones").
3. **Named location** `AF-Test-Location` (IP range from the documentation range) for the named-locations page.
4. **Conditional Access** (only if 0.3 chose Conditional Access): one **report-only** policy `AF-Test-CA` scoped to
   AF-Test-Group-01 — never enforced, never targeting real people.
5. **Intune:** `AF-Test` compliance policy and configuration profile assigned to AF-Test-Group-01 (no devices needed),
   so policy and assignment pages have data; a test device from 0.4 joins AF-Test-Group-01.
6. **Identity Protection:** a risky user on demand — the live suite runs "confirm compromised" on AF-Test-User-03 and
   then "dismiss", so the risky-user pages and playbooks are exercised end to end.
7. The second validation account the backlog asks for (`AF Tester 2`, Playbook.Approver only) so approval flows —
   mailbox forwarding, critical playbooks, write-capable schedules — can be tested with two people.

Each item: idempotent, reversible, in `tests/unit/cli/` with the fake Graph, documented in `tests/live/README.md` and
the validating-against-a-tenant skill.

## Phase 2 — validate and fix, area by area (parallel, one owner per area)

| Area                       | Content                                                                                       | Live checks                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 2a Entra ID P1             | sign-ins (list, detail, user page panels), auth registration, users without MFA, inactive users/guests, CA policies and named locations, dynamic rule edit | every datasource as the tester; filters and facets on sign-ins; KQL-free `$filter` limits; empty-tenant states |
| 2b Entra ID P2             | PIM page, role page, privileged role assignments; add/remove eligibility, activate; risky users and runbook | eligibility add → remove on AF-Test-User-01; tester activates its eligible role; confirm/dismiss on AF-Test-User-03 |
| 2c Intune                  | devices, device page, compliance, configuration, apps, Autopilot, six endpoint reports, device actions | `managedDevices` query-builder `$filter` fields (backlog), report POST endpoints as reads (backlog), actions on the AF-Test device only |
| 2d Defender XDR + Endpoint | incidents, alerts, hunting (email and device tables), vulnerabilities, device and CVE links   | after 0.2/0.4; incident playbooks on a test incident only                                                           |
| 2e Licence plumbing        | playbook preflight checks feature keys, not only SKU names (backlog); one Entra P1 feature key across API and widget (backlog) | a playbook needing `pim` shows no false "Requires …"                                                                |

Schedules and probes of each area are checked once as the automation identity with
`tests/live/scripts/run-schedule-once.ts` (dev database, delivery suppressed).

## Phase 3 — unattended work and delivery

- Every schedule built on the newly unlocked areas runs once green as the automation identity, then is enabled.
- Failure alerts and report recipients configured (`AF_SCHEDULE_ALERTS`, `AF_REPORT_RECIPIENTS`) — owner's choice of
  recipients; the sender mailbox and its scoped Exchange permission already exist.
- App-only Exchange in the runner (backlog), so the Exchange report schedules (external forwarding, shared-mailbox
  sign-in) run unattended — certificate-based, scoped with Exchange RBAC for Applications like the report sender.

## Phase 4 — robustness

- **A recurring read-only live sweep** (every page and report of every licensed area, as the validation user) on a
  timer, reporting counts per area to the Monitoring page; writes stay manual.
- **A licence and seat probe:** alerts when a licence content depends on disappears, a subscription is suspended, or
  people who had a licence are left without one.
- **Least privilege:** remove the automation identity's unused `TeamSettings.Read.All` and `Device.Read.All`; review
  the tester's opt-in service roles (`AF_TEST_SERVICE_ADMIN_ROLES`) against scoped alternatives (backlog).
- **Data freshness** checks for Defender, Intune and usage reports (they arrive late in new tenants) so empty pages
  explain themselves.

## Phase 5 — tooling: organised, modular, documented

The audit of every utility, script and tool (CLI, live scripts, runner scripts and module, deploy scripts, hooks,
package scripts) and the changes it led to are in the section below; the conventions themselves are in
`docs/onboarding/03-repository-map.md` and `05-coding-standards.md`.

### What the audit found

An audit of every tool (the `adminforge` CLI, `tooling/`, git and Claude Code hooks, CI, the PowerShell runner module and
content scripts, deploy scripts, the live-validation scripts and the test harness) found:

- **Rules kept in several copies that had already drifted:** the "is this tenant data?" rule (CLI and guard test),
  the design-token patterns (ESLint, guard test, after-edit hook), and the runner-script sha256 pin check (hook and
  a content test that only covered nine definitions).
- **Output that could leak:** two live scripts printed Microsoft error text unmasked; one printed a display name.
- **Files mixing several jobs:** the CLI's content command module (five commands, ~900 lines), the runner's PowerShell
  module (events, inputs, connections and the security-critical read-only policy in one ~870-line file), a CLI
  context module with an import cycle.
- **Reaching into another app's internals:** the CLI, the scheduler and live scripts import `@adminforge/api/src/...`
  directly; the scheduler's one-shot run was copied into a live script.
- **Duplicated harness code:** session builders, people fixtures (two pairs even shared an object id), preview/poll
  loops, credential builders.
- **Missing documentation:** no README for the CLI, `tooling/`, the runner or the content scripts; most CLI modules and
  several helpers without the module header the coding standards ask for; several tools without tests.

### What changed (done 2026-10-16)

| Area                       | Change                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One rule, one place        | tenant-value rule in `@adminforge/config`; design-token patterns in `tooling/lint/`; script pins checked by `adminforge validate` for every definition           |
| CLI                        | one module per command; review-state and content lint rules in their own modules; layering without cycles (shared errors/output, provision settings/clients, env/) |
| API surface for tools      | `@adminforge/api/tooling` and `@adminforge/api/tooling/scheduler` — documented entry points instead of deep imports; the scheduler one-shot as a reusable module                                         |
| Runner                     | the PowerShell module split into dot-sourced files by concern (exports unchanged); Pester reuses the module installer                                             |
| Deploy                     | deploy constants in one place; an install script for the systemd units; a test for the database-role script                                                     |
| Live tooling and harness   | all live output masked; shared run/preview helpers and credentials; one people/roles module and app/session builder for API tests; content fixtures out of code   |
| Docs                       | READMEs for the CLI, `tooling/`, the runner and content scripts; module headers everywhere touched; a shared-helpers section in `tests/README.md`                  |
| Tests for tools            | bundle-budget check, after-edit hook decisions, module installer, runner health check, CLI audit/env commands, commit-scope sync across the three places they live |

### Deferred, with reasons

- **A shared helper module for Exchange content scripts** (target lookup, external-domain check, forwarding read,
  rights list are repeated across scripts): it would have to join the runner's read-only allow-list, which is a
  security decision — recorded in the backlog.
- **One certificate/PEM implementation** shared by the CLI and the API's automation identity: needs a small package of
  its own; recorded in the backlog.
- **Merging the CLI's two fake clouds** (Entra and Azure test fakes): low value against the risk of churn in 40+ tests.


## Order and acceptance

1. Phase 0 (owner) and Phase 5 (tooling) can start at once; Phase 1 needs 0.5 (and 0.3 for Conditional Access).
2. Phase 2 areas run in parallel once Phase 1 fixtures exist; 2d also needs 0.2 and 0.4.
3. Phases 3 and 4 follow their areas.

Done when, for each area: every definition's datasources answer on the host as the validation user (or explain a
documented Microsoft limitation), every write playbook has run dry run → run → reverse on AF-Test objects (device
wipe/retire: dry run and refusals), every schedule and probe has run once green as the automation identity,
`docs/licensing-review.md` records what was verified, and the recurring sweep is green.
