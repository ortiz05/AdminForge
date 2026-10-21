---
name: adding-a-playbook
description: Use when asked to add or change an AdminForge action, playbook, runbook, row or bulk action, or any automated change to Entra ID, M365, Intune, Defender or Azure objects (disable user, reset MFA, add group member, restart app, etc.).
---

# Adding a playbook or runbook

## Overview

Write actions are playbooks: YAML in `portal/content/playbooks/<prefix>/`, executed by `@adminforge/engine` with the
engineer's delegated identity (Write app, only while armed). Runbooks (`runbooks/`) are guided procedures that mix
Markdown sections, manual steps and executable steps.

## When not to use

- Showing data, with no change → `adding-a-page-or-report`.
- A change only PowerShell can make (Exchange, Teams, SharePoint) → write the script with `adding-a-runner-script`,
  then call it from a playbook step here.
- Running a playbook unattended → a `playbook` job (`adding-a-schedule-or-probe`); scheduled writes need two-person
  approval.
- A generic write proxy, app-only permissions on an interactive path, or a new kind of write the engine can't express —
  never in content; a new step type is engine code with a `security-reviewer` pass.

## Steps

1. **Reuse first.** `pnpm adminforge list --kind playbook,runbook --section <section>` (or `--search "<action>"`) —
   prefer extending an existing playbook (add a guard step, bump `version`) over a near-duplicate. Call another
   playbook with a `type: playbook` step.
2. **Scaffold:** `pnpm adminforge new playbook <prefix>/<name>` (or `new runbook …`); the folder is the id prefix.
3. **Inputs** use typed params (`user`, `group`, `device`, `app`, `resource`, `guid`, `enum`, …) — they become the
   form; a `pattern:` describes the whole value and must not backtrack (`docs/content-recipes.md` › Param and input
   patterns). Sensitive inputs get `redact: true` (masked in stored steps, events and audit; a step that would send a masked
   value fails with `redacted_value`). Manual-step fields are masked the same way, and only the person a manual step
   waits for can supply its values.
4. **Steps:** read first (look up the target, `assert` preconditions so a stale screen can't act on the wrong object),
   then writes. Every write step: `mode: write`, `describe` (plain language — shown in the dry-run plan), `compensate`
   where an undo exists. PUT/PATCH/DELETE must be `write`; POST must declare a mode.
   - **`idempotent: false`** on every write whose repeat would hurt (a message sent twice, a second object created).
     It matters on every restart, not only after a crash: a step still in flight 10 s after a stop is retried unless
     it says `idempotent: false` — then the run ends `needs_review` instead. Checks run again before the retry, but
     they can't tell whether the first send took effect.
   - **Guards are `assert` steps** — not a branch `if`, a forEach's `items` filter or a read's `when`. A run that
     paused (an approval, input, write access, a sign-in, a `wait`, a restart) runs its asserts and the reads they use
     again right before its next write; what it decided before the pause (branch arms, forEach items, the `when` of
     reads and checks) stays decided. A write's own `when` is worked out again too, but a false one only skips the
     write, with no message.
   - **Ids that get reused or go stale** (AVD user session numbers are reused on a host): take what the list showed as
     an input from the row (`expectedUser: ${ row.properties.userPrincipalName }` in `rowActions` and
     `bulkActions[].forEach.inputs`) and `assert` it against the fresh read before the write, with a message that says
     who holds it now (`avd.log-off-user-session`: `sameUser`).
   - `compensate` runs only when a **later** step fails with `onError: compensate` (completed steps are undone in
     reverse). A playbook whose last step is its only write has nothing to undo it: don't promise an undo — say "run it
     again with the other setting" (`avd.set-drain-mode`).
5. **Risk:** `risk: low|medium|high|critical`. `high` and `critical` playbooks and runbooks need a `confirm` block (the
   schema enforces it), `typed` with the value the person recognises (the UPN, the object's name). A playbook offered as
   a bulk action (`bulkActions`) confirms by typing from `medium` up too: a bulk run asks for the item count. `click` is
   for low risk, and for medium-risk changes never offered in bulk; low-risk bulk actions may click
   (`tests/content/high-risk-typed-confirm.test.ts` enforces the typing). A name anyone can choose (an app's, a group's)
   can't always be typed: work out the value in a `confirmAs` step that falls back to the object id
   (`identity.revoke-consent-grant`). `critical` also needs `approval: { required: true }` (two-person; the approver
   runs the remaining steps as themselves). A change that **grants access** (a directory or Azure role, membership of a
   role-assignable group, app ownership) names who it benefits in `approval.excludes` (an expression yielding object
   ids — the principal, and a group's members when the principal is a group) so they can't approve it, and refuses
   adding yourself (`notSelf` assert). Approvals expire after 72 hours unless you set `expiresIn`. Don't put
   `onError: continue` on an approval: `validate` refuses it, and a rejected, expired or unworkable approval always
   stops the run. After an approval the reads before it run again with the approver's access before the next write,
   so the approver needs read access to them (otherwise the run stops). A playbook that starts a child with its own
   confirmation, or a high/critical child, needs a `confirm` block itself.
6. **Secrets** (passwords, TAPs, client secrets): declare `secretOutputs: [path]` on the step; never copy them to
   `outputs`. Generate passwords with `$secureRandom(n)`. A playbook that changes the caller's own permissions (PIM
   activation) sets `refreshTokens: true` so the new roles apply as soon as it succeeds.
7. **Paths and queries** — user data placed as `docs/content-recipes.md` › Quoting user data shows: `$encode()` path
   segments, `$odata()` (outside your own quotes) / `$odataSearch()` / `$guid()` in `$filter`, `$search`, `$orderby`
   and `$expand` (query or body), a literal allow-list for `$orderby`, `$kql()` in KQL. Wrapping doesn't help:
   `validate` follows inputs, items, `forEach` items and `steps.x.output` through functions and variables (a transform
   step that encodes stays clean). A whole `path` may be an entity or guid input as it is (`type: resource`). Assign
   variables only as block statements.
   - **In a write** (a `mode: write` step, a changing batch request, any `compensate`) the segment after `/users/` — in
     the path, a `$id` query or an `@odata.id` / `…@odata.bind` reference — is `$guid(…)`, even for an id an earlier
     step returned: `/users/${ $encode($guid(inputs.userId)) }`. Look a UPN up in a `mode: read` step first. `validate`
     refuses anything else and the API refuses such a write (`user_not_by_id`).
   - Don't set `Authorization`, `Cookie`, `Proxy-Authorization`, `Host` or the client-request-id headers: AdminForge
     sets them, and `validate` refuses them.
8. **Declare** `requires.portalRoles` (`Portal.Operator` for writes), `requires.scopes` (exact write scopes — they must
   exist on the Write app; check with `pnpm adminforge validate --scopes`), `requires.entraRoles`, and for Azure
   `requires.azureRoles` — the narrowest built-in role that allows the write (`Desktop Virtualization Session Host
Operator` for drain mode, `Desktop Virtualization User Session Operator` for messages and sign-outs), not Owner or
   Contributor. Tier-0 scopes (role management/PIM, app credentials and owners, app-role and consent grants,
   `Directory.AccessAsUser.All`, tenant policies — `portal/tools/cli/src/provision/privilege.ts`) are only granted with
   `AF_ALLOW_PRIVILEGED_WRITE_SCOPES=true`: say so in the PR.
   - AdminForge's own access is protected centrally: the executor refuses any write naming its apps, the principals
     holding its app roles (the `SG-AdminForge-*` groups), `AF_PROTECTED_APP_IDS` or `AF_PROTECTED_USER_IDS`
     (`protected_object`), REST or PowerShell. Add the friendly early asserts (`notPortalGroup`, `notPortalApp` — copy
     them from `add-group-members` / `add-app-owner`) when a playbook targets groups or apps, so people see why before
     anything runs. PowerShell writes are matched by the object ids in their parameters only: resolve the accounts
     through Graph and pass their ids (`adding-a-runner-script`, step 10).
   - A change that hands someone another person's mail or files (mailbox forwarding, mailbox or OneDrive access)
     refuses the person running it (`notYou` on `user.oid`/`user.upn`); forwarding also needs `approval` with
     `excludes` naming the recipient and the mailbox's owner (`m365.set-mailbox-forwarding`).
9. **Tests:** a `tests:` block per behaviour — happy path, each precondition refusal, compensation — with `mocks` per
   step id and `expect.{status, failedStep, plan}`; a test may set `now` and `env` (e.g.
   `env: { AF_READ_CLIENT_ID: … }` for guards that read configuration). Run `pnpm adminforge test <id>`.
10. **Wire it:** reference it from pages (`rowActions`, `bulkActions`, `actionBar` — `adding-a-page-or-report`).
    Bulk: the table's `bulkActions[].maxItems` (default 100, at most 1,000) caps a selection in the browser only; the
    API takes up to 1,000 items a run whatever the page says. What the drawer asks once for every item (a reason, a
    message) travels as `inputsTemplate` and is recorded, redacted, on the bulk run's `run.created` audit event — so
    ask for a `reason` there rather than per row.
11. **Try it in mock mode:** arm with the dev toolbar, preview, then run to the end. A write with no fixture is
    accepted (there is no tenant); a read needs one (`docs/content-recipes.md` › Fixtures). Drafts can be previewed
    but never run.
12. **Validate live only on `AF-Test-*` objects** (`validating-against-a-tenant`): dry run, then run, then compensate.

## Done when

- [ ] `pnpm adminforge validate` and `pnpm adminforge test <id>` are clean, with a test per refusal and for
      compensation
- [ ] Every write step has `mode: write`, `describe`, a risk-appropriate `confirm` / `approval`, `idempotent: false`
      where a repeat hurts and `compensate` where an undo exists
- [ ] Every precondition is an `assert` step before the write it guards (so it runs again after a pause)
- [ ] Scopes exist on the Write app (`validate --scopes`); a tier-0 opt-in is named in the PR
- [ ] It runs end to end in mock mode from the page that offers it
- [ ] Dry run → run → compensate passed on `AF-Test-*` objects, or the live check is recorded as still to do
- [ ] `content-reviewer` ran and its findings are fixed or answered

## Common mistakes

| Mistake                                                                              | Fix                                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Write step without `describe` / undeclared POST mode                                 | Schema rejects it — describe what changes, in plain words                                       |
| No precondition read → acts on stale data                                            | `graph` read + `assert` before the write                                                        |
| A write that names a user by UPN or address                                          | Look the user up in a read step; `/users/${ $encode($guid(…)) }`                                |
| A POST or runner write that must not run twice, left idempotent                      | `idempotent: false` — a restart retries in-flight steps otherwise                               |
| A guard written as a branch `if`, a forEach `items` filter or a read's `when`        | An `assert` step: asserts and the reads they use run again before a resumed run's next write    |
| `onError: continue` on an approval                                                   | `validate` refuses it: a rejected, expired or unworkable approval always stops the run          |
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
| `confirm: click` on a bulk action of risk `medium` or higher                         | `typed`: one click would apply to every selected row; a bulk run asks for the count             |

## See also

- `docs/content-recipes.md` — quoting user data, fixtures, versions and retiring
- `docs/onboarding/08-content-guide.md` › Write safety (playbooks and runbooks); `SECURITY.md` › Write access
  ("arming")
- `adding-a-runner-script`, `adding-a-schedule-or-probe`, `validating-against-a-tenant`
