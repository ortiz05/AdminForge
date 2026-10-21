<#
.SYNOPSIS
    Runs the AdminForge runner Pester tests with the pinned Pester version.

.DESCRIPTION
    Installs the pinned Pester version into the runner's module directory when it is missing or other Pester
    versions sit next to it (through portal/apps/runner/scripts/install-modules.ps1 -Name Pester),
    then puts that directory first on PSModulePath the way the workers do (so the tests see the same module
    versions as jobs) and runs every *.Tests.ps1 here. The helpers come from
    portal/apps/runner/scripts/RunnerModules.ps1.
    Prints "PESTER total=… passed=… failed=… skipped=…" (tests/unit/runner/pester.pwsh.test.ts reads it).
    Exit code = number of failed tests.

.EXAMPLE
    pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('None', 'Normal', 'Detailed', 'Diagnostic')][string]$Output = 'Detailed'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$runner = Join-Path $repo 'portal/apps/runner'
. (Join-Path $runner 'scripts/RunnerModules.ps1')

$modulesDir = Get-RunnerModulesDir -RunnerRoot $runner
$pester = Get-PinnedModule -Lock (Read-RunnerModuleLock -Path (Join-Path $runner 'modules.lock.json')) -Name Pester
if (@(Get-ModuleInstallPlan -Pinned $pester -Destination $modulesDir | Where-Object Action -ne 'ok').Count) {
    & (Join-Path $runner 'scripts/install-modules.ps1') -Destination $modulesDir -Name Pester
}
$pesterVersion = $pester['Pester']

$env:ADMINFORGE_RUNNER_MODULES_DIR = $modulesDir
Set-RunnerModulePath -ModulesDir $modulesDir
Import-Module Pester -RequiredVersion $pesterVersion

$config = New-PesterConfiguration
$config.Run.Path = $PSScriptRoot
$config.Run.PassThru = $true
$config.Output.Verbosity = $Output
$result = Invoke-Pester -Configuration $config
Write-Host ("PESTER total={0} passed={1} failed={2} skipped={3}" -f $result.TotalCount, $result.PassedCount, $result.FailedCount, $result.SkippedCount)
exit $result.FailedCount
