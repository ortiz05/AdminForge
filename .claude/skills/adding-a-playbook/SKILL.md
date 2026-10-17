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
   - **Ids that get reused or go stale** (AVD user session numbers are reused on a host): take what the list showed
     as an input from the row (`expectedUser: ${ row.properties.userPrincipalName }` in `rowActions` and
     `bulkActions[].forEach.inputs`) and `assert` it against the fresh read before the write, with a message that
     says who holds it now (`avd.log-off-user-session`: `sameUser`).
   - `compensate` runs only when a **later** step fails with `onError: compensate` (completed steps are undone in
     reverse). A playbook whose last step is its only write has nothing to undo it: don't promise an undo — say "run
     it again with the other setting" (`avd.set-drain-mode`).
5. **Risk:** `risk: low|medium|high|critical`. `high` and `critical` need a `confirm` block — prefer `typed` with the
   value the person recognises (the UPN, the object's name; a bulk run then asks for the item count), `click` only
   for low-impact changes; `critical` also needs `approval: { required: true }` (two-person; the approver runs the remaining
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
   exist on the Write app; check with `pnpm adminforge validate --scopes`), `requires.entraRoles`, and for Azure
   `requires.azureRoles` — the narrowest built-in role that allows the write (`Desktop Virtualization Session Host
Operator` for drain mode, `Desktop Virtualization User Session Operator` for messages and sign-outs), not Owner or
   Contributor. Tier-0 scopes
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
    Bulk: the table's `bulkActions[].maxItems` (default 100, at most 1,000) caps a selection in the browser only; the
    API takes up to 1,000 items a run whatever the page says. What the drawer asks once for every item (a reason, a
    message) travels as `inputsTemplate` and is recorded, redacted, on the bulk run's `run.created` audit event — so
    ask for a `reason` there rather than per row.
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
| A row action on an id that can be reused (session numbers) without an owner check    | Pass `expected…` from the row and `assert` it against the fresh read before the write           |
| Promising an undo for a playbook whose only write is its last step                   | `compensate` runs only when a later step fails; describe how to reverse it by hand              |
| `risk: high` with `confirm: click` on a bulk action                                  | `typed`: one click would apply to every selected row; typed asks for the count                  |
