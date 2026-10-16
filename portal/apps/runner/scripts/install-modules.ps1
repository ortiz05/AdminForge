<#
.SYNOPSIS
    Installs the exact PowerShell module versions pinned in modules.lock.json.

.DESCRIPTION
    Saves each pinned module from the gallery into the runner's private module directory
    (default: portal/apps/runner/modules, git-ignored). Workers put that directory first on
    PSModulePath, so the pinned versions win over anything installed for the user.

    Modules that are already present at the pinned version are skipped. Versions that are not
    pinned are removed from the directory so the lock file stays the single source of truth; a full
    install (no -Name) also removes modules the lock file doesn't pin at all.

    The decisions live in RunnerModules.ps1 (Get-PinnedModule, Get-ModuleInstallPlan), shared with
    tests/runner/pester/run.ps1 and covered offline by tests/runner/pester/InstallModules.Tests.ps1.
    Prints one line per module (ok / install / remove) — names and versions only.

.PARAMETER Destination
    Target directory. Defaults to <runner>/modules or $env:ADMINFORGE_RUNNER_MODULES_DIR.

.PARAMETER Production
    Install only the runtime modules (skip devModules such as Pester). Used by the Dockerfile.

.PARAMETER Name
    Install only these pinned modules (e.g. Pester for the test runner) and leave other modules alone.

.PARAMETER LockFile
    The lock file to read. Defaults to <runner>/modules.lock.json.

.EXAMPLE
    pnpm --filter @adminforge/runner modules:install

.EXAMPLE
    pwsh -File portal/apps/runner/scripts/install-modules.ps1 -Name Pester
#>
[CmdletBinding()]
param(
    [string]$Destination,
    [switch]$Production,
    [string[]]$Name,
    [string]$LockFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'RunnerModules.ps1')

$runnerRoot = Split-Path -Parent $PSScriptRoot
if (-not $LockFile) { $LockFile = Join-Path $runnerRoot 'modules.lock.json' }
if (-not $Destination) { $Destination = Get-RunnerModulesDir -RunnerRoot $runnerRoot }

$lock = Read-RunnerModuleLock -Path $LockFile
$wanted = Get-PinnedModule -Lock $lock -Production:$Production -Name $Name
$repository = if ($lock.Contains('repository') -and $lock['repository']) { $lock['repository'] } else { 'PSGallery' }

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

foreach ($step in @(Get-ModuleInstallPlan -Pinned $wanted -Destination $Destination -Prune:(-not $Name))) {
    switch ($step.Action) {
        'ok' { Write-Host "ok      $($step.Name) $($step.Version)" }
        'install' {
            Write-Host "install $($step.Name) $($step.Version)"
            # Dependencies are not followed: every module the runner needs is pinned explicitly, and the
            # ones ExchangeOnlineManagement declares (PackageManagement, PowerShellGet) ship with pwsh.
            Save-PSResource -Name $step.Name -Version $step.Version -Repository $repository -Path $Destination `
                -TrustRepository -SkipDependencyCheck -AcceptLicense -Quiet
            if (-not (Test-Path -LiteralPath (Join-Path $step.Path "$($step.Name).psd1"))) {
                throw "Save-PSResource did not produce $($step.Path)/$($step.Name).psd1"
            }
        }
        'remove' {
            $what = if ($step.Version) { "$($step.Name) $($step.Version)" } else { $step.Name }
            Write-Host "remove  $what ($($step.Reason))"
            Remove-Item -LiteralPath $step.Path -Recurse -Force
        }
    }
}

Write-Host "Modules installed in $Destination"
