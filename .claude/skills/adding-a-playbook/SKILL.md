---
name: adding-a-playbook
description: Use when asked to add or change an AdminForge action, playbook, runbook, row or bulk action, or any automated change to Entra ID, M365, Intune, Defender or Azure objects (disable user, reset MFA, add group member, restart app, etc.).
---

# Adding a playbook or runbook

## Overview

Write actions are playbooks: YAML in `portal/content/playbooks/<section>/`, executed by `@adminforge/engine` with the
engineer's delegated identity (Write app, only while armed). Runbooks (`runbooks/`) are guided procedures that mix
Markdown sections, manual steps and executable steps.

## Steps

1. **Reuse first.** `rg "^id:" portal/content/playbooks` — prefer extending an existing playbook (add a guard step,
   bump `version`) over a near-duplicate. Call another playbook with a `type: playbook` step.
2. **Scaffold:** `pnpm adminforge new playbook <section>/<name>` (or `new runbook …`).
3. **Inputs** use typed params (`user`, `group`, `device`, `app`, `resource`, `guid`, `enum`, …) — they become the form.
4. **Steps:** read first (look up the target, `assert` preconditions so a stale screen can't act on the wrong object),
   then writes. Every write step: `mode: write`, `describe` (plain language — shown in the dry-run plan),
   `compensate` where an undo exists, `idempotent: false` if retrying could double-apply.
   PUT/PATCH/DELETE must be `write`; POST must declare a mode.
5. **Risk:** `risk: low|medium|high|critical`. `high` and `critical` need a `confirm` block (click, or a typed value
   such as the UPN); `critical` also needs `approval: { required: true }` (two-person; the approver runs the remaining
   steps as themselves). A change that **grants access** (a directory or Azure role, membership of a role-assignable
   group, app ownership) must name who it benefits in `approval.excludes` (an expression yielding object ids — the
   principal, and a group's members when the principal is a group) so they can't approve it, and refuse adding yourself
   (`notSelf` assert). Approvals expire after 72 hours unless you set `expiresIn`.
6. **Secrets** (passwords, TAPs, client secrets): declare `secretOutputs: [path]` on the step; never copy them to
   `outputs`. Generate passwords with `$secureRandom(n)`. Sensitive **inputs** get `redact: true` (masked in stored
   steps, events and audit). A playbook that changes the caller's own permissions (PIM activation) sets
   `refreshTokens: true` so the new roles apply as soon as it succeeds.
7. **Paths & queries:** `$encode()` path segments, `$odata()` / `$odataSearch()` / `$guid()` for any user data in
   `$filter`, `$search` or `$orderby` (query or body — even inside a quoted literal), a literal allow-list for
   `$orderby`, `$kql()` in KQL. `validate` and `publish` refuse anything else.
8. **Declare** `requires.portalRoles` (`Portal.Operator` for writes), `requires.scopes` (exact write scopes — they must
   exist on the Write app; check with `pnpm adminforge validate --scopes`), `requires.entraRoles`. Tier-0 scopes
   (role management/PIM, app credentials and owners, app-role and consent grants, `Directory.AccessAsUser.All`,
   tenant policies — `portal/tools/cli/src/provision/privilege.ts`) are only granted with
   `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`: say so in the PR.
   - AdminForge's own access is protected centrally: the executor refuses any write naming its apps, the principals
     holding its app roles (the `SG-AdminForge-*` groups), `AF_PROTECTED_APP_IDS` or `AF_PROTECTED_USER_IDS`
     (`protected_object`), REST or PowerShell. You don't need your own check; add the friendly early asserts
     (`notPortalGroup`, `notPortalApp` — copy them from `add-group-members` / `add-app-owner`) when a playbook targets
     groups or apps, so people see why before anything runs. PowerShell writes are matched by the object ids in their
     parameters only: resolve the accounts through Graph and pass their ids (see adding-a-runner-script, step 10).
   - A change that hands someone another person's mail or files (mailbox forwarding, mailbox or OneDrive access)
     refuses the person running it (`notYou` on `user.oid`/`user.upn`); forwarding also needs `approval` with
     `excludes` naming the recipient and the mailbox's owner (`m365.set-mailbox-forwarding`).
   - A playbook that starts a child with its own confirmation, or a high/critical child, needs a `confirm` block itself
     (validation enforces it). Drafts can be previewed but never run.
   - `redact: true` inputs and manual-step fields are masked everywhere, including run outputs; a step that would send
     a masked value fails (`redacted_value`). Only the person a manual step waits for can supply its values.
9. **Tests:** a `tests:` block per behaviour (a test may set `now` and `env` — e.g. `env: { AF_READ_CLIENT_ID: … }` for guards that read configuration) (happy path, each precondition refusal, compensation) with `mocks` per
   step id and `expect.{status, failedStep, plan}`. Run `pnpm adminforge test <id>`.
10. **Wire it:** reference it from pages (`rowActions`, `bulkActions`, `actionBar`) — see adding-a-page-or-report.
11. **Validate live only on `AF-Test-*` objects** (see validating-against-a-tenant): dry run, then run, then compensate.

## Common mistakes

| Mistake                                                                              | Fix                                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Write step without `describe` / undeclared POST mode                                 | Schema rejects it — describe what changes, in plain words                                       |
| No precondition read → acts on stale data                                            | `graph` read + `assert` before the write                                                        |
| Secret in `outputs` or logs                                                          | `secretOutputs`; it's delivered once to the initiator                                           |
| New write scope not on the Write app                                                 | Add to provisioning desired state, `pnpm adminforge provision entra`, record in docs            |
| Bulk flow as a custom loop                                                           | Page `bulkActions` with `forEach.inputs` — one child run per item                               |
| Sensitive input echoed into a request or output                                      | Declare it `redact: true` — its value is masked in stored steps, events and audit               |
| Restricting a playbook with `requires.portalRoles` and expecting previews to be open | Previews check those roles too (their read steps really run)                                    |
| Publishing a new version of a playbook a write schedule runs                         | Expected: that schedule switches off until a second person re-approves it                       |
| Deleting a playbook/runbook you replaced or merged (it stays live in the database)   | `status: retired` + bump `version`; point page actions and `type: playbook` steps at the new id |
| `x != 'a'` on a value that may be missing (false when `x` is undefined)              | `$not(x = 'a')`                                                                                 |
