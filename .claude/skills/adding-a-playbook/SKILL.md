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
   steps as themselves).
6. **Secrets** (passwords, TAPs, client secrets): declare `secretOutputs: [path]` on the step; never copy them to
   `outputs`. Generate passwords with `$secureRandom(n)`. Sensitive **inputs** get `redact: true` (masked in stored
   steps, events and audit). A playbook that changes the caller's own permissions (PIM activation) sets
   `refreshTokens: true` so the new roles apply as soon as it succeeds.
7. **Paths & queries:** `$encode()` path segments, `$odata()` in filters, `$kql()` in KQL.
8. **Declare** `requires.portalRoles` (`Portal.Operator` for writes), `requires.scopes` (exact write scopes — they must
   exist on the Write app; check with `pnpm adminforge validate --scopes`), `requires.entraRoles`.
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
