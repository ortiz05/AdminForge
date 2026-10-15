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
2. Connect with `Connect-AdminForgeServices -Context $Context -Services Exchange,Graph,…`; emit results with
   `Write-AdminForgeOutput` (one object per row), progress with `Write-AdminForgeProgress`, logs with
   `Write-AdminForgeLog`. Never write tokens or secrets.
3. Inputs are data — never build commands by string interpolation (`Invoke-Expression` is forbidden).
4. Read scripts only call `Get-*` (read mode replaces every other command with a guard). Write scripts are used from
   playbook steps with `mode: write`.
5. Pin it: `sha256sum portal/content/scripts/<path>` → put `script` + `sha256` in the datasource/step. **Any edit to
   the script changes the hash — update every reference.**
6. Fixture for mock mode: `tests/fixtures/runner/<script path>.json` (array of output objects).
7. Tests: Pester in `tests/runner/pester/Scripts.Tests.ps1` with stub cmdlets
   (`pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1`); runner unit tests in
   `tests/unit/runner/`.
8. New PowerShell module? Pin it in `portal/apps/runner/modules.lock.json` and `pnpm --filter @adminforge/runner modules:install`.

Live Exchange/Teams/SharePoint validation needs licensed workloads — see `docs/licensing-review.md`.
