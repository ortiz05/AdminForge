---
name: adding-a-runner-script
description: Use when an AdminForge feature needs PowerShell (Exchange Online, distribution lists, Teams admin, SharePoint/PnP) or any task Microsoft Graph cannot do, run through the PowerShell runner.
---

# Adding a runner script

## Overview

`portal/apps/runner` executes **pinned** scripts from `portal/content/scripts/<area>/<Verb-Noun>.ps1` in single-use
pwsh workers, with the engineer's delegated tokens. Content references a script by path **and sha256**; the runner
refuses anything else. Conventions in one place: `portal/content/scripts/README.md`; how the runner works:
`portal/apps/runner/README.md`.

## When not to use

- Graph can do it → a datasource or playbook step on Graph (`adding-a-page-or-report`, `adding-a-playbook`): no runner
  round trip, no module pins.
- Unattended PowerShell: a schedule's `script` job validates but fails with `script_not_supported` — the runner can't
  yet sign in as the automation identity. Prefer a `kql` probe or a report.
- A new helper or allowed command for read scripts changes the runner's read-only policy: that is runner code
  (`ReadOnlyPolicy.ps1`) with a `security-reviewer` pass, not a script change.

## Steps

1. Copy an existing script (e.g. `scripts/exchange/Get-MailboxSummary.ps1`): comment-based help, `[CmdletBinding()]`,
   `Set-StrictMode -Version Latest`, `param([hashtable]$Inputs, [hashtable]$Context)`.
2. Don't connect in the script: list the services it needs in the datasource or step `services` (`graph`,
   `exchange`, `teams`, `sharepointAdmin`, `arm`) and the worker connects with the forwarded delegated tokens before it
   runs (and, in read mode, checks the script against the read-only policy, then guards every write command). Read
   inputs with `Get-AdminForgeInput` (typed, bounded); emit results with `Write-AdminForgeOutput` (`-Data` for one
   object, or pipe rows), progress with `Write-AdminForgeProgress`, logs with `Write-AdminForgeLog`, failures with
   `New-AdminForgeError`. Never write tokens or secrets.
3. Inputs are data — never build commands by string interpolation (`Invoke-Expression` is forbidden).
4. Read scripts pass the runner's **read-only policy** (checked before the script runs; a refusal names the line):
   `Get-*` commands (not ones returning tokens or connections), the AdminForge helpers, the script's own functions and
   a fixed set of utilities (`ForEach-/Where-/Select-/Sort-/Group-/Measure-Object`, `ConvertTo/From-Json`, `Get-Date`,
   …). No `Module\Verb-Noun` except to allowed commands, no `& $x`, no `$env:`/`$ExecutionContext`, no
   `.Invoke()`/`.GetType()`/`.ExecuteQuery()` or change methods (`.Update()`, `.Delete…()`, `.Set…()`, `.CopyTo()` —
   copy a collection with `@($set)`), properties and indexes set only on a variable the script assigns nothing but
   `@{…}`/`[ordered]@{…}` (`$result = [ordered]@{…}; $result.total = 3`; a new `[ordered]@{}` per row under its own
   name — not `[pscustomobject]@{}`, `$_`, a parameter, a `foreach` variable or what a `Get-*` command returned), no
   wildcard member names (`ForEach-Object Upd*`), no `-as $string`, no classes or `using`, and no file redirection (`>`,
   `>>`, `2>`, `*>`, also `> $null` and `2>$null`): discard output with `| Out-Null`, silence a stream with
   `-ErrorAction SilentlyContinue` (merging a stream, `2>&1`, stays allowed). .NET types from a small allow-list only.
   Service writes fail at the call. Check with `Test-AdminForgeReadOnlyScript -Content (Get-Content -Raw <file>)` (the
   Pester `Invoke-ContentScript` helper applies it in read mode). Write scripts are used from playbook steps with
   `mode: write`.
5. Pin it: `sha256sum portal/content/scripts/<path>` → put `script` + `sha256` in the datasource or step. **Any edit to
   the script changes the hash — update every reference;** `pnpm adminforge validate` lists every stale or missing pin
   with the new hash (the after-edit hook runs it when a script changes). Write scripts start with
   `if ($Context['Mode'] -ne 'write') { throw (New-AdminForgeError -Category readOnly …) }`, read the target first,
   change only what differs (idempotent), read it back, and return before/after so the run record shows what changed.
6. Fixture for mock mode: `tests/fixtures/runner/<script path>.json` (the array of output objects; wrap it in
   `{ "$fixture": { "body": …, "variants": [{ "match": { "bodyIncludes": … }, "body": … }] } }` to answer per input —
   format at the top of `portal/packages/connectors/src/fixtures.ts`).
7. Tests: Pester with stub cmdlets in a **new** `tests/runner/pester/<Area>.Tests.ps1` that dot-sources
   `ContentScript.Helpers.ps1` (`Invoke-ContentScript`, `New-Stub`, `Remove-Stubs`) and removes its stubs in
   `AfterAll` (see `MailboxAdmin.Tests.ps1`); the contract test in `Scripts.Tests.ps1` already covers every script's
   help, params and strict mode. Cover read mode for write scripts (`readOnly`), input validation (`input`) and
   idempotency. Stubs inherit the script's strict mode: index hashtables with `ContainsKey`, not missing properties.
   Run with `pnpm --filter @adminforge/tests test:pwsh` (real PowerShell; Pester runs through
   `tests/unit/runner/pester.pwsh.test.ts`) or directly with
   `pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1`. Tests that start real
   pwsh are named `tests/unit/runner/<topic>.pwsh.test.ts`.
8. New PowerShell module? Pin it in `portal/apps/runner/modules.lock.json` and
   `pnpm --filter @adminforge/runner modules:install`. A new helper for scripts belongs in the `AdminForge.Runner`
   module (`portal/apps/runner/ps/AdminForge.Runner/`, one file per concern; add it to `FunctionsToExport` and
   `Export-ModuleMember`) — and, for read scripts, to the read-only policy's allow-list in `ReadOnlyPolicy.ps1`, which
   needs a security review.
9. SharePoint: a SharePoint Administrator can't open other people's sites or OneDrives, so read and change them through
   the tenant admin connection (`sharepointAdmin`): `Get-PnPTenantSite -Identity <url>` (SiteId, lock state, storage),
   and OneDrive site collection administrators with `sharepoint/Set-SiteCollectionAdmin.ps1` (reuse it; it reads them
   back, and refuses team sites — a team-site mode would be a separate, reviewed parameter). The tenant site list
   returns no owner for group-connected sites (`GroupId` instead).
10. **Object ids for the protected-object guard.** The executor refuses a write naming AdminForge's own principals or
    `AF_PROTECTED_USER_IDS`, but it only sees GUIDs in a runner job's parameters, not UPNs or addresses. A write script
    that changes something of a person, mailbox or group takes their Entra object ids as required inputs
    (`mailboxObjectId`, `trusteeObjectId`, `ownerObjectId`, …; the playbook passes ids it resolved through Graph) and
    refuses to act when they don't match what the service reports (`ExternalDirectoryObjectId` in Exchange, the
    profile's `msOnline-ObjectId` in SharePoint). Refuse acting for the caller where that grants them access
    (`$Context['User']` has `Upn` and `ObjectId`); Pester passes it with `Invoke-ContentScript … -User @{ … }`.
11. Creating Exchange recipients (`New-SharedMailbox`, `New-RoomMailbox`, `New-DistributionList`): pass `-Name` = alias
    (the availability check covers it), mark the object straight away by the `Guid` the `New-*` cmdlet returned, then
    wait for its account; only a list's owners can change it, so the engineer (who needs a mailbox) is a temporary
    owner. The `CustomAttribute15` mark is a guard rail, not authorization (`SECURITY.md` › Known gaps and accepted
    risks).

## Done when

- [ ] `pnpm adminforge validate` is clean: every reference carries the script's current sha256
- [ ] Pester covers the script's read mode (`readOnly` for write scripts), input validation and idempotency, and passes
      under `test:pwsh`; a read script passes `Test-AdminForgeReadOnlyScript`
- [ ] A synthetic runner fixture makes its page or step work in mock mode
- [ ] Write scripts take object ids, check them against the service and return before/after
- [ ] Live Exchange / Teams / SharePoint behaviour checked once (`validating-against-a-tenant`) — or recorded as
      unchecked in `docs/licensing-review.md` and `docs/backlog.md` (it needs licensed workloads)

## Common mistakes

| Mistake (learned live, mostly Exchange Online)                                    | Fix                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `> $null` or `2>$null` in a read script                                           | Refused by the read-only policy: `\| Out-Null`, `-ErrorAction SilentlyContinue`                           |
| Expecting ISO 8601 inputs to arrive as dates                                      | Inputs stay as sent (the worker parses jobs with `-DateKind String`): parse dates in the script           |
| Printing raw service payloads                                                     | `Format-AdminForgeMessage` already strips Exchange's OData JSON and `\|Exception.Type\|` prefixes         |
| Returning an `if`/`switch` expression that can yield an empty array as a property | PowerShell unrolls it to `$null` (`findings: null` broke transforms): use `@(… \| Where-Object …)`        |
| Treating `Get-EXOMailboxPermission -User <x>`'s NotFound as an error              | It throws "No permissions were found …" when x has none: that means "not granted"                         |
| Comparing `GrantSendOnBehalfTo`, `ForwardingAddress` or `ManagedBy` by address    | They hold recipient Names, often the Entra object id: compare through `Get-EXORecipient`                  |
| Counting any lookup failure as "not there"                                        | Only ManagementObjectNotFound means free or gone; throttling, permission and "multiple entries" stop it   |
| `*` in an address                                                                 | An identity wildcard: refuse it                                                                           |
| Enabling a mailbox's account with `Set-Mailbox -AccountDisabled $false`           | Accepted but left disabled (live, 2026-10-17): `PATCH /users/{id}` `accountEnabled` through Graph instead |
| Inbox rules by name                                                               | Address them by `RuleIdentity` with `-Mailbox`; `-Force` (unattended); hidden rules ("Junk E-mail Rule")  |
| Graph `mailboxSettings` of someone else's mailbox                                 | ErrorAccessDenied with delegated permissions: read mailbox facts from Exchange                            |
| "Module could not be correctly formed" right after an Exchange role assignment    | RBAC propagation: wait up to an hour                                                                      |
| `$d.Contains('msOnline-ObjectId')` on `Get-PnPUserProfileProperty` output         | `UserProfileProperties` is a generic `Dictionary`: `@($d.Keys) -contains 'msOnline-ObjectId'`             |
| `Invoke-PnPSPRestMethod` (e.g. `GetSiteSecondaryAdministrators`) in a read script | Calls with no `Get-*` cmdlet only work in write scripts                                                   |
| Editing a script and leaving the old sha256 in content                            | `validate` prints the new hash for every stale pin; update each reference                                 |

## See also

- `portal/content/scripts/README.md` (script conventions), `portal/apps/runner/README.md` (how the runner works)
- `SECURITY.md` › PowerShell runner; `docs/licensing-review.md` (what live Exchange, Teams and SharePoint need)
- `adding-a-playbook` (calling a write script), `validating-against-a-tenant`
