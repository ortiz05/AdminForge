<#
.SYNOPSIS
    Installs the exact PowerShell module versions pinned in modules.lock.json.

.DESCRIPTION
    Saves each pinned module from the gallery into the runner's private module directory
    (default: portal/apps/runner/modules, git-ignored). Workers put that directory first on
    PSModulePath, so the pinned versions win over anything installed for the user.

    Modules that are already present at the pinned version are skipped. Versions that are not
    pinned are removed from the directory so the lock file stays the single source of truth.

.PARAMETER Destination
    Target directory. Defaults to <runner>/modules or $env:ADMINFORGE_RUNNER_MODULES_DIR.

.PARAMETER Production
    Install only the runtime modules (skip devModules such as Pester). Used by the Dockerfile.

.EXAMPLE
    pnpm --filter @adminforge/runner modules:install
#>
[CmdletBinding()]
param(
    [string]$Destination,
    [switch]$Production
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$runnerRoot = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $runnerRoot 'modules.lock.json'
if (-not $Destination) {
    $Destination = if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { $env:ADMINFORGE_RUNNER_MODULES_DIR } else { Join-Path $runnerRoot 'modules' }
}

$lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json -AsHashtable
$wanted = [ordered]@{}
foreach ($k in $lock.modules.Keys) { $wanted[$k] = $lock.modules[$k] }
if (-not $Production -and $lock.ContainsKey('devModules')) {
    foreach ($k in $lock.devModules.Keys) { $wanted[$k] = $lock.devModules[$k] }
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$repository = if ($lock.repository) { $lock.repository } else { 'PSGallery' }

foreach ($name in $wanted.Keys) {
    $version = $wanted[$name]
    $moduleDir = Join-Path $Destination $name
    $versionDir = Join-Path $moduleDir $version
    if (Test-Path -LiteralPath (Join-Path $versionDir "$name.psd1")) {
        Write-Host "ok      $name $version"
    } else {
        Write-Host "install $name $version"
        # Dependencies are not followed: every module the runner needs is pinned explicitly, and the
        # ones ExchangeOnlineManagement declares (PackageManagement, PowerShellGet) ship with pwsh.
        Save-PSResource -Name $name -Version $version -Repository $repository -Path $Destination `
            -TrustRepository -SkipDependencyCheck -AcceptLicense -Quiet
        if (-not (Test-Path -LiteralPath (Join-Path $versionDir "$name.psd1"))) {
            throw "Save-PSResource did not produce $versionDir/$name.psd1"
        }
    }
    # Drop versions that are not pinned.
    Get-ChildItem -LiteralPath $moduleDir -Directory | Where-Object Name -ne $version | ForEach-Object {
        Write-Host "remove  $name $($_.Name) (not pinned)"
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}

# Drop modules that are not pinned at all (e.g. dev modules in a production install).
Get-ChildItem -LiteralPath $Destination -Directory | Where-Object { -not $wanted.Contains($_.Name) } | ForEach-Object {
    Write-Host "remove  $($_.Name) (not in modules.lock.json)"
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
}

Write-Host "Modules installed in $Destination"
