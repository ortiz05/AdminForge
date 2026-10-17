# Runner scripts

PowerShell that AdminForge runs through the PowerShell runner (`portal/apps/runner`) for what Microsoft Graph can't do:
Exchange Online, Teams admin, SharePoint/PnP. A datasource (`source: runner`) or a playbook step references a script
here by path **and sha256**; the runner refuses anything else. Prefer Graph when it can do the job. The step-by-step
recipe is the `adding-a-runner-script` skill (`.claude/skills/adding-a-runner-script/SKILL.md`).

| Folder         | What                                                                |
| -------------- | ------------------------------------------------------------------- |
| `exchange/`    | Mailboxes, permissions, forwarding, inbox rules, distribution lists |
| `sharepoint/`  | Sites, sharing, OneDrive and site collection administrators         |
| `teams/`       | Teams user policies                                                 |
| `diagnostics/` | `Test-Runner.ps1`, the runner smoke test                            |

## Conventions

- **One script per job, named `<area>/<Verb-Noun>.ps1`**, with an approved verb: `Get-` for reads; `Set-`, `Clear-`,
  `Convert-`, … for writes.
- **Comment-based help** at the top: `.SYNOPSIS`, `.DESCRIPTION`, `.PARAMETER Inputs` (one line per input: name, type,
  required or default, limits), `.PARAMETER Context`, `.OUTPUTS` (the shape of what it emits) and `.NOTES` with
  `Tokens: <services>`, `Mode: read|write` and the admin role it needs.
- **The contract:** `[CmdletBinding()]`, `param([hashtable]$Inputs = @{}, [hashtable]$Context = @{})`,
  `Set-StrictMode -Version Latest` and `$ErrorActionPreference = 'Stop'`. `$Context` comes from the runner: `JobId`,
  `Mode`, `Tenant`, `Services`, `User` (`Upn`, `ObjectId` of the engineer).
- **Never connect, never handle tokens.** List the services in the datasource/step (`services: [exchange]`); the worker
  connects with the engineer's forwarded delegated tokens before the script runs.
- **Inputs through `Get-AdminForgeInput`** — typed (`-Type String|Int|Bool|StringArray|Object`), bounded (`-MaxLength`,
  `-Minimum`/`-Maximum`, `-MaxCount`) and checked (`-Pattern`, `-AllowedValues`, `-Required`). Inputs are data: never
  build commands or script text from them (`Invoke-Expression`, `[scriptblock]::Create` are refused).
- **Output through the helpers:** `Write-AdminForgeOutput` (`-Data` for one object, or pipe rows; project with
  `Select-Object` first — live module objects can be deep or cyclic), `Write-AdminForgeProgress`, `Write-AdminForgeLog`.
  Fail with `throw (New-AdminForgeError -Category input|auth|readOnly|script -Message '…')` — a message the person in
  front of the browser can act on. Never print tokens, secrets or raw service payloads.
- **Read scripts** must pass the runner's read-only policy (checked before the script runs): `Get-*` service commands,
  the AdminForge helpers, the script's own functions and a fixed set of utilities; no module-qualified or dynamic calls,
  reflection, `$env:`, classes or unlisted .NET types. Check one with
  `Test-AdminForgeReadOnlyScript -Content (Get-Content -Raw <file>)`. Service writes fail at the call.
- **Write scripts** (used only from playbook steps with `mode: write`) start by refusing read mode:
  `if ($Context['Mode'] -ne 'write') { throw (New-AdminForgeError -Category readOnly …) }`. They read the target first,
  change only what differs (idempotent), read it back, and return before/after so the run record shows what changed.
- **Object ids for writes about a person, mailbox or group.** The executor's protected-object guard only sees GUIDs in
  a job's parameters, so such a write takes the Entra object ids as required inputs (`mailboxObjectId`,
  `trusteeObjectId`, `ownerObjectId`, …; the playbook resolves them through Graph) and refuses to act when they don't
  match what the service reports (`ExternalDirectoryObjectId` in Exchange, `msOnline-ObjectId` in SharePoint). Refuse
  acting for the caller where that grants them access (`$Context['User']`).
- **Scripts that create something mark it straight away and only remove what they marked.** `New-SharedMailbox`,
  `New-RoomMailbox` and `New-DistributionList` set `CustomAttribute15` to `AdminForge-created by <engineer> on <date>`
  by the id the `New-*` cmdlet returned, before waiting for the account, so a job that stops leaves an object AdminForge
  can still finish or remove. A second run for the same address finishes that object (idempotent) only when the
  playbook passes its object id (`existingObjectId`); any other recipient using the address or alias is refused.
  `Remove-CreatedRecipient` removes only a marked recipient of the kind asked whose `ExternalDirectoryObjectId`
  matches, by its Exchange id. **The mark is a guard rail against mistakes, not authorization**: any Exchange
  administrator can set it (SECURITY.md → Known gaps), so the playbooks also ask for the address to be typed.
- **Recipient lookups:** only "couldn't find object" means a value is free or a recipient gone; throttling, permission
  or "matches multiple entries" errors stop the job. Look recipients up by identity (`Get-EXORecipient -Identity`),
  never with a filter built from input, and refuse `*` in addresses (an identity wildcard). `Get-RecipientAvailability`
  is the read-only preflight: accepted domains, whether an address or alias is taken and by what (with a readable
  `typeLabel`), and a list's owners as Entra object ids.
- **People given access or ownership** are checked before anything changes, as `Set-MailboxPermission` does: the
  object id must match, they must be a user mailbox in the organization (no guests, contacts or shared mailboxes) and
  not the engineer running it. Keep these checks in step with `Set-MailboxPermission.ps1` and the playbooks'
  `notYou` / guest asserts (`m365.grant-mailbox-permission`).
- **Distribution lists:** Exchange only lets a list's owners change or remove it (Organization Management can bypass
  that). `New-DistributionList` makes the engineer — who therefore needs a mailbox — a temporary owner, and takes them
  off only when everything succeeded, so a re-run can retry what failed.

## Pins

Content pins each script's sha256 (`script: exchange/Get-MailboxSummary.ps1` + `sha256: <hex>`); the runner hashes the
file and refuses a mismatch. **Any edit changes the hash:** run `sha256sum portal/content/scripts/<path>` and update
every reference. `pnpm adminforge validate` reports every stale or missing pin with the new hash (the Claude Code
after-edit hook runs it whenever a script here changes).

## Tests and fixtures

- **Pester mirror:** `tests/runner/pester/<Area>.Tests.ps1` (a new file per area) dot-sources `ContentScript.Helpers.ps1`
  (`Invoke-ContentScript`, `New-Stub`, `Remove-Stubs`), stubs the service cmdlets, and covers inputs (`input` errors),
  read mode for write scripts (`readOnly`) and idempotency. `Scripts.Tests.ps1` checks every script's help, contract and
  strict mode. Run: `pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1`.
- **Mock-mode fixture:** `tests/fixtures/runner/<script path>.json` (format at the top of
  `portal/packages/connectors/src/fixtures.ts`).
- Live checks need licensed workloads: `docs/licensing-review.md`.
