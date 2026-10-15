---
name: adding-a-runner-script
description: Use when an AdminForge feature needs PowerShell (Exchange Online, distribution lists, Teams admin, SharePoint/PnP) or any task Microsoft Graph cannot do, run through the PowerShell runner.
---

# Adding a runner script

## Overview

`portal/apps/runner` executes **pinned** scripts from `portal/content/scripts/<area>/<Verb-Noun>.ps1` in single-use
pwsh workers, with the engineer's delegated tokens. Content references a script by path **and sha256**; the runner
refuses anything else. Prefer Graph when it can do the job.

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
   the script changes the hash — update every reference.** Write scripts start with
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

Live Exchange/Teams/SharePoint validation needs licensed workloads — see `docs/licensing-review.md`.
