---
name: adding-a-runner-script
description: Use when an AdminForge feature needs PowerShell (Exchange Online, distribution lists, Teams admin, SharePoint/PnP) or any task Microsoft Graph cannot do, run through the PowerShell runner.
---

# Adding a runner script

## Overview

`portal/apps/runner` executes **pinned** scripts from `portal/content/scripts/<area>/<Verb-Noun>.ps1` in single-use
pwsh workers, with the engineer's delegated tokens. Content references a script by path **and sha256**; the runner
refuses anything else. Prefer Graph when it can do the job. Conventions in one place:
`portal/content/scripts/README.md`; how the runner works: `portal/apps/runner/README.md`.

## Steps

1. Copy an existing script (e.g. `scripts/exchange/Get-MailboxSummary.ps1`): comment-based help, `[CmdletBinding()]`,
   `Set-StrictMode -Version Latest`, `param([hashtable]$Inputs, [hashtable]$Context)`.
2. Don't connect in the script: list the services it needs in the datasource/step `services`
   (`graph`, `exchange`, `teams`, `sharepointAdmin`, `arm`) and the worker connects with the forwarded delegated
   tokens before it runs (and, in read mode, checks the script against the read-only policy, then guards every write command). Read inputs with `Get-AdminForgeInput`
   (typed, bounded); emit results with `Write-AdminForgeOutput` (`-Data` for one object, or pipe rows), progress with
   `Write-AdminForgeProgress`, logs with `Write-AdminForgeLog`, failures with `New-AdminForgeError`. Never write tokens
   or secrets.
3. Inputs are data — never build commands by string interpolation (`Invoke-Expression` is forbidden).
4. Read scripts pass the runner's **read-only policy** (checked before the script runs; a refusal names the line):
   `Get-*` commands (not ones returning tokens or connections), the AdminForge helpers, the script's own functions and
   a fixed set of utilities (`ForEach-/Where-/Select-/Sort-/Group-/Measure-Object`, `ConvertTo/From-Json`, `Get-Date`,
   …). No `Module\Verb-Noun` except to allowed commands, no `& $x`, no `$env:`/`$ExecutionContext`, no
   `.Invoke()`/`.GetType()`/`.ExecuteQuery()`, no `-as $string`, no classes or `using`; .NET types from a small
   allow-list only. Service writes fail at the call. Check with `Test-AdminForgeReadOnlyScript -Content (Get-Content
-Raw <file>)` (the Pester `Invoke-ContentScript` helper applies it in read mode). Write scripts are used from
   playbook steps with `mode: write`.
5. Pin it: `sha256sum portal/content/scripts/<path>` → put `script` + `sha256` in the datasource/step. **Any edit to
   the script changes the hash — update every reference;** `pnpm adminforge validate` lists every stale or missing pin
   with the new hash (the after-edit hook runs it when a script changes). Write scripts start with
   `if ($Context['Mode'] -ne 'write') { throw (New-AdminForgeError -Category readOnly …) }`, read the target first, change
   only what differs (idempotent), read it back, and return before/after so the run record shows what changed.
6. Fixture for mock mode: `tests/fixtures/runner/<script path>.json` (the array of output objects; wrap it in
   `{ "$fixture": { "body": …, "variants": [{ "match": { "bodyIncludes": … }, "body": … }] } }` to answer per input —
   format at the top of `portal/packages/connectors/src/fixtures.ts`).
7. Tests: Pester with stub cmdlets in a **new** `tests/runner/pester/<Area>.Tests.ps1` that dot-sources
   `ContentScript.Helpers.ps1` (`Invoke-ContentScript`, `New-Stub`, `Remove-Stubs`) and removes its stubs in `AfterAll`
   (see `MailboxAdmin.Tests.ps1`); the contract test in `Scripts.Tests.ps1` already covers every script's help, params
   and strict mode. Cover read mode for write scripts (`readOnly`), input validation (`input`) and idempotency. Stubs
   inherit the script's strict mode: index hashtables with `ContainsKey`, not missing properties. Run with
   `pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1`; runner unit tests are
   in `tests/unit/runner/`.
8. New PowerShell module? Pin it in `portal/apps/runner/modules.lock.json` and `pnpm --filter @adminforge/runner modules:install`.
   A new helper for scripts belongs in the `AdminForge.Runner` module (`portal/apps/runner/ps/AdminForge.Runner/`, one
   file per concern; add it to `FunctionsToExport` and `Export-ModuleMember`) — and, for read scripts, to the read-only
   policy's allow-list in `ReadOnlyPolicy.ps1`, which needs a security review.
9. SharePoint: a SharePoint Administrator can't open other people's sites or OneDrives, so read and change them through
   the tenant admin connection (`sharepointAdmin`): `Get-PnPTenantSite -Identity <url>` (SiteId, lock state, storage),
   and OneDrive site collection administrators with `sharepoint/Set-SiteCollectionAdmin.ps1` (reuse it; it reads them
   back, and refuses team sites — a team-site mode would be a separate, reviewed parameter). The tenant site list
   returns no owner for group-connected sites (`GroupId` instead). Calls PnP has no `Get-*` cmdlet for
   (`Invoke-PnPSPRestMethod`, e.g. `GetSiteSecondaryAdministrators`) only work in write scripts.
   `Get-PnPUserProfileProperty` returns CSOM `PersonProperties`: `UserProfileProperties` is a generic `Dictionary`
   whose `Contains` PowerShell can't call — test keys with `@($d.Keys) -contains 'msOnline-ObjectId'`.
10. **Object ids for the protected-object guard.** The executor refuses a write naming AdminForge's own principals or
    `AF_PROTECTED_USER_IDS`, but it only sees GUIDs in a runner job's parameters, not UPNs or addresses. A write script
    that changes something of a person, mailbox or group takes their Entra object ids as required inputs
    (`mailboxObjectId`, `trusteeObjectId`, `ownerObjectId`, …; the playbook passes ids it resolved through Graph) and
    refuses to act when they don't match what the service reports (`ExternalDirectoryObjectId` in Exchange, the
    profile's `msOnline-ObjectId` in SharePoint). Refuse acting for the caller where that grants them access
    (`$Context['User']` has `Upn` and `ObjectId`); Pester passes it with `Invoke-ContentScript … -User @{ … }`.
11. Exchange Online (learned live):
    - Inputs stay as sent: ISO 8601 strings are strings (the worker parses jobs with `-DateKind String`); parse dates
      in the script.
    - Error and log text is cleaned for the browser (`Format-AdminForgeMessage` strips Exchange's OData JSON and
      `|Exception.Type|` prefixes); don't print raw service payloads yourself.
    - Never return an `if`/`switch` expression that can yield an empty array as a property value — PowerShell unrolls
      it to `$null` (`findings: null` broke transforms). Use `@(… | Where-Object …)` directly.
    - `Get-EXOMailboxPermission -User <x>` throws NotFound ("No permissions were found …") when x has none: treat that
      as "not granted". Recipient links (`GrantSendOnBehalfTo`, `ForwardingAddress`, `ManagedBy`) hold recipient
      Names, often the Entra object id: compare through `Get-EXORecipient`, not by address.
    - Lookups: only "couldn't find object" (ManagementObjectNotFound) means free or gone; throttling, permission and
      "matches multiple entries" errors must stop the job, never count as "not there". Refuse `*` in addresses (an
      identity wildcard).
    - Creating recipients (`New-SharedMailbox`, `New-RoomMailbox`, `New-DistributionList`): pass `-Name` = alias (the
      availability check covers it), mark the object straight away by the `Guid` the `New-*` cmdlet returned, then wait
      for its account; only a list's owners can change it, so the engineer (who needs a mailbox) is a temporary owner.
      The `CustomAttribute15` mark is a guard rail, not authorization (SECURITY.md → Known gaps).
    - Inbox rules: address them by `RuleIdentity` with `-Mailbox`; the rule cmdlets need `-Force` (unattended) and
      can't see hidden rules (every mailbox has Exchange's hidden "Junk E-mail Rule").
    - Graph `mailboxSettings` of someone else's mailbox answers ErrorAccessDenied with delegated permissions — read
      mailbox facts (type, forwarding, replies) from Exchange.
    - "Could not connect to Exchange: Module could not be correctly formed" right after an Exchange role is assigned
      (or the organization was customized) is RBAC propagation: wait up to an hour.

Live Exchange/Teams/SharePoint validation needs licensed workloads — see `docs/licensing-review.md`.
