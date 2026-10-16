<#
    Pinned-module helpers for the AdminForge runner's tooling. Dot-source it; it defines functions only.

    Used by scripts/install-modules.ps1 (installs modules.lock.json into the runner's module directory) and by
    tests/runner/pester/run.ps1 (installs the pinned Pester there and runs the suite with the workers' module path).
    tests/runner/pester/InstallModules.Tests.ps1 covers the decisions offline.

    The worker (ps/worker.ps1) sets the same module path itself: the runner image ships ps/ but not scripts/.

      Get-RunnerModulesDir     where pinned modules live: $env:ADMINFORGE_RUNNER_MODULES_DIR or <runner>/modules
      Read-RunnerModuleLock    modules.lock.json as a hashtable
      Get-PinnedModule         the name → version pins to install (runtime, plus dev modules unless -Production)
      Get-ModuleInstallPlan    what an install does: ok / install / remove, without touching anything
      Set-RunnerModulePath     PSModulePath = the pinned module directory, then PowerShell's own modules only
#>

function Get-RunnerModulesDir {
    <# .SYNOPSIS The runner's pinned-module directory: $env:ADMINFORGE_RUNNER_MODULES_DIR, else <RunnerRoot>/modules. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$RunnerRoot)
    if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { return $env:ADMINFORGE_RUNNER_MODULES_DIR }
    Join-Path $RunnerRoot 'modules'
}

function Read-RunnerModuleLock {
    <# .SYNOPSIS Reads modules.lock.json ({ repository?, modules: {name: version}, devModules?: {…} }). #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$Path)
    $lock = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
    if ($lock -isnot [System.Collections.IDictionary] -or $lock['modules'] -isnot [System.Collections.IDictionary]) {
        throw "$Path has no 'modules' object."
    }
    $lock
}

function Get-PinnedModule {
    <#
    .SYNOPSIS
        The pins to install, in lock-file order: every runtime module, plus devModules (Pester) unless -Production.
        -Name keeps only the named pins and throws for a name the lock file doesn't pin.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Lock,
        [switch]$Production,
        [string[]]$Name
    )
    $pins = [ordered]@{}
    foreach ($k in $Lock['modules'].Keys) { $pins[$k] = [string]$Lock['modules'][$k] }
    if (-not $Production -and $Lock.Contains('devModules') -and $Lock['devModules']) {
        foreach ($k in $Lock['devModules'].Keys) { $pins[$k] = [string]$Lock['devModules'][$k] }
    }
    if (-not $Name) { return $pins }
    $selected = [ordered]@{}
    foreach ($n in $Name) {
        $key = @($pins.Keys | Where-Object { $_ -eq $n }) | Select-Object -First 1
        if (-not $key) { throw "$n is not pinned in modules.lock.json$(if ($Production) { ' (runtime modules)' })." }
        $selected[$key] = $pins[$key]
    }
    $selected
}

function Get-ModuleInstallPlan {
    <#
    .SYNOPSIS
        What installing these pins into -Destination does, without changing anything. One hashtable per step, in order:
          @{ Action = 'ok' | 'install' | 'remove'; Name; Version; Path; Reason }
        A pin is 'ok' when <Destination>/<name>/<version>/<name>.psd1 exists, else 'install'. Other versions of a pinned
        module are removed. With -Prune, modules that aren't pinned at all are removed too (a full install; not when
        installing a few named pins next to others).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Pinned,
        [Parameter(Mandatory)][string]$Destination,
        [switch]$Prune
    )
    $plan = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($name in $Pinned.Keys) {
        $version = $Pinned[$name]
        $moduleDir = Join-Path $Destination $name
        $versionDir = Join-Path $moduleDir $version
        $action = if (Test-Path -LiteralPath (Join-Path $versionDir "$name.psd1")) { 'ok' } else { 'install' }
        $plan.Add(@{ Action = $action; Name = $name; Version = $version; Path = $versionDir; Reason = $null })
        if (Test-Path -LiteralPath $moduleDir) {
            foreach ($dir in @(Get-ChildItem -LiteralPath $moduleDir -Directory | Where-Object Name -ne $version)) {
                $plan.Add(@{ Action = 'remove'; Name = $name; Version = $dir.Name; Path = $dir.FullName; Reason = 'not pinned' })
            }
        }
    }
    if ($Prune -and (Test-Path -LiteralPath $Destination)) {
        foreach ($dir in @(Get-ChildItem -LiteralPath $Destination -Directory | Where-Object { -not $Pinned.Contains($_.Name) })) {
            $plan.Add(@{ Action = 'remove'; Name = $dir.Name; Version = $null; Path = $dir.FullName; Reason = 'not in modules.lock.json' })
        }
    }
    $plan.ToArray()
}

function Set-RunnerModulePath {
    <#
    .SYNOPSIS
        Puts the pinned module directory first on PSModulePath and drops the user's and machine-wide module paths, as
        the workers do (ps/worker.ps1), so tooling and tests load the same module versions as jobs.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$ModulesDir)
    if ($PSCmdlet.ShouldProcess('PSModulePath', "pinned modules first ($ModulesDir)")) {
        $env:PSModulePath = $ModulesDir + [System.IO.Path]::PathSeparator + (Join-Path $PSHOME 'Modules')
    }
}
