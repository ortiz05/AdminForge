<#
.SYNOPSIS
    Runs the AdminForge runner Pester tests with the pinned Pester version.

.DESCRIPTION
    Puts the runner's pinned module directory first on PSModulePath (so the tests see the same module
    versions as the workers) and installs the pinned Pester version there if it is missing.
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
$modulesDir = if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { $env:ADMINFORGE_RUNNER_MODULES_DIR } else { Join-Path $runner 'modules' }
$lock = Get-Content -Raw -LiteralPath (Join-Path $runner 'modules.lock.json') | ConvertFrom-Json -AsHashtable
$pesterVersion = $lock['devModules']['Pester']

New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
$env:ADMINFORGE_RUNNER_MODULES_DIR = $modulesDir
$env:PSModulePath = $modulesDir + [System.IO.Path]::PathSeparator + (Join-Path $PSHOME 'Modules')
if (-not (Test-Path -LiteralPath (Join-Path $modulesDir "Pester/$pesterVersion/Pester.psd1"))) {
    Write-Host "Installing Pester $pesterVersion into $modulesDir"
    Save-PSResource -Name Pester -Version $pesterVersion -Repository PSGallery -Path $modulesDir -TrustRepository -SkipDependencyCheck -Quiet
}
Import-Module Pester -RequiredVersion $pesterVersion

$config = New-PesterConfiguration
$config.Run.Path = $PSScriptRoot
$config.Run.PassThru = $true
$config.Output.Verbosity = $Output
$result = Invoke-Pester -Configuration $config
Write-Host ("PESTER total={0} passed={1} failed={2} skipped={3}" -f $result.TotalCount, $result.PassedCount, $result.FailedCount, $result.SkippedCount)
exit $result.FailedCount
