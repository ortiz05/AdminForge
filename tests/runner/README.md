# PowerShell runner tests (Pester)

The PowerShell side of the runner (`portal/apps/runner`): the `AdminForge.Runner` module, the worker, the module
tooling, and every content script in `portal/content/scripts`. The Node side is in `tests/unit/runner/` (the `pwsh` vitest
project also runs this suite, through `pester.pwsh.test.ts`).

```sh
pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1            # all, detailed
pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1 -Output None
```

`pester/run.ps1` installs the pinned Pester (`modules.lock.json` → `portal/apps/runner/scripts/install-modules.ps1
-Name Pester`) when it's missing, puts the runner's pinned module directory first on `PSModulePath` as the workers do,
runs every `*.Tests.ps1` and prints `PESTER total=… passed=… failed=… skipped=…`. Tests that need a real service module
(Exchange, PnP, …) skip when it isn't installed (`pnpm --filter @adminforge/runner modules:install`).

| File                                  | Covers                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `AdminForge.Runner.Tests.ps1`         | Events, inputs, errors, connections (mocked `Connect-*`), the worker end to end                       |
| `ReadOnlyPolicy.Tests.ps1`            | The read-only policy (static) and runtime guards — the security boundary                              |
| `ReadOnlyPolicyRedirection.Tests.ps1` | File redirection refused in read mode (S-35)                                                          |
| `RunnerMessages.Tests.ps1`            | `Format-AdminForgeMessage` (service error text for the browser)                                       |
| `ModuleLayout.Tests.ps1`              | Manifest and `Export-ModuleMember` agree; every function lives in a concern file                      |
| `InstallModules.Tests.ps1`            | `install-modules.ps1` and `RunnerModules.ps1`, offline (mocked `Save-PSResource`)                     |
| `Scripts.Tests.ps1`                   | Every content script's contract (help, params, strict mode) and the first Exchange/SharePoint scripts |
| `<Area>.Tests.ps1`                    | Content scripts per area (`MailboxAdmin`, `SiteSharing`, `TeamsOneDrive`, …)                          |
| `ContentScript.Helpers.ps1`           | Not a test: `Invoke-ContentScript` (runs a script as the worker does), `New-Stub`, `Remove-Stubs`     |

Conventions: synthetic data only (`example.com`, `fabrikam.example`, generated GUIDs); anything that changes global
session state (read-only mode's guards) runs in a separate `pwsh` (`Invoke-Isolated`); a new content area gets a new
`<Area>.Tests.ps1` that dot-sources `ContentScript.Helpers.ps1` and removes its stubs in `AfterAll`.
