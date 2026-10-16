#Requires -Version 7.4
# portal/apps/runner/scripts/install-modules.ps1 and its helpers (RunnerModules.ps1), offline: a lock file and module
# directories in TestDrive, and a mocked Save-PSResource that writes a fake manifest instead of reaching the gallery.
# Run with tests/runner/pester/run.ps1.

BeforeAll {
    $script:ScriptsDir = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/apps/runner/scripts')).Path
    $script:InstallScript = Join-Path $ScriptsDir 'install-modules.ps1'
    . (Join-Path $ScriptsDir 'RunnerModules.ps1')

    $script:Lock = @{
        repository = 'PSGallery'
        modules    = [ordered]@{ 'Example.Graph' = '2.0.0'; 'Example.Exchange' = '3.1.0' }
        devModules = [ordered]@{ Pester = '6.2.0' }
    }

    function New-InstalledModule([string]$Root, [string]$Name, [string]$Version) {
        $dir = Join-Path $Root "$Name/$Version"
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir "$Name.psd1") -Value '@{}'
    }

    function New-Sandbox {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root | Out-Null
        $lockFile = Join-Path $root 'modules.lock.json'
        $Lock | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $lockFile
        @{ Root = $root; LockFile = $lockFile; Modules = (Join-Path $root 'modules') }
    }

    function Get-Tree([string]$Root) {
        @(Get-ChildItem -LiteralPath $Root -Directory | ForEach-Object {
                $name = $_.Name
                Get-ChildItem -LiteralPath $_.FullName -Directory | ForEach-Object { "$name/$($_.Name)" }
            } | Sort-Object)
    }
}

Describe 'Get-RunnerModulesDir' {
    It 'uses ADMINFORGE_RUNNER_MODULES_DIR when set, else the modules folder of the runner' {
        $saved = $env:ADMINFORGE_RUNNER_MODULES_DIR
        try {
            $env:ADMINFORGE_RUNNER_MODULES_DIR = '/opt/adminforge/modules'
            Get-RunnerModulesDir -RunnerRoot '/srv/runner' | Should -Be '/opt/adminforge/modules'
            $env:ADMINFORGE_RUNNER_MODULES_DIR = $null
            Get-RunnerModulesDir -RunnerRoot '/srv/runner' | Should -Be (Join-Path '/srv/runner' 'modules')
        } finally {
            $env:ADMINFORGE_RUNNER_MODULES_DIR = $saved
        }
    }
}

Describe 'Get-PinnedModule' {
    It 'pins runtime and dev modules in lock-file order' {
        $pins = Get-PinnedModule -Lock $Lock
        @($pins.Keys) | Should -Be @('Example.Graph', 'Example.Exchange', 'Pester')
        $pins['Pester'] | Should -Be '6.2.0'
    }

    It 'leaves dev modules out of a production install' {
        @((Get-PinnedModule -Lock $Lock -Production).Keys) | Should -Be @('Example.Graph', 'Example.Exchange')
    }

    It 'keeps only the named pins and refuses a name the lock file does not pin' {
        $pins = Get-PinnedModule -Lock $Lock -Name pester
        @($pins.Keys) | Should -Be @('Pester')
        { Get-PinnedModule -Lock $Lock -Name 'Evil.Module' } | Should -Throw '*Evil.Module is not pinned*'
        { Get-PinnedModule -Lock $Lock -Name Pester -Production } | Should -Throw '*not pinned*'
    }

    It 'refuses a lock file without modules' {
        $file = Join-Path $TestDrive 'broken.lock.json'
        Set-Content -LiteralPath $file -Value '{"devModules":{}}'
        { Read-RunnerModuleLock -Path $file } | Should -Throw "*has no 'modules' object*"
    }
}

Describe 'Get-ModuleInstallPlan' {
    It 'installs missing pins, keeps present ones, removes unpinned versions and (with -Prune) unpinned modules' {
        $s = New-Sandbox
        New-InstalledModule $s.Modules 'Example.Graph' '2.0.0'
        New-InstalledModule $s.Modules 'Example.Graph' '1.9.0'
        New-InstalledModule $s.Modules 'Stray.Module' '1.0.0'
        $plan = @(Get-ModuleInstallPlan -Pinned (Get-PinnedModule -Lock $Lock) -Destination $s.Modules -Prune)
        @($plan | ForEach-Object { '{0} {1} {2}' -f $_.Action, $_.Name, $_.Version }) | Should -Be @(
            'ok Example.Graph 2.0.0'
            'remove Example.Graph 1.9.0'
            'install Example.Exchange 3.1.0'
            'install Pester 6.2.0'
            'remove Stray.Module '
        )
        # Planning changes nothing.
        Get-Tree $s.Modules | Should -Be @('Example.Graph/1.9.0', 'Example.Graph/2.0.0', 'Stray.Module/1.0.0')
    }

    It 'leaves modules that are not pinned alone without -Prune' {
        $s = New-Sandbox
        New-InstalledModule $s.Modules 'Stray.Module' '1.0.0'
        $plan = @(Get-ModuleInstallPlan -Pinned (Get-PinnedModule -Lock $Lock -Name Pester) -Destination $s.Modules)
        @($plan.Action) | Should -Be @('install')
    }

    It 'treats a version folder without its manifest as not installed' {
        $s = New-Sandbox
        New-Item -ItemType Directory -Force -Path (Join-Path $s.Modules 'Pester/6.2.0') | Out-Null
        @(Get-ModuleInstallPlan -Pinned (Get-PinnedModule -Lock $Lock -Name Pester) -Destination $s.Modules).Action | Should -Be 'install'
    }
}

Describe 'install-modules.ps1' {
    BeforeEach {
        Mock Save-PSResource {
            $dir = Join-Path $Path "$Name/$Version"
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            Set-Content -LiteralPath (Join-Path $dir "$Name.psd1") -Value '@{}'
        }
        Mock Write-Host {}
    }

    It 'installs exactly the pinned versions and removes everything else' {
        $s = New-Sandbox
        New-InstalledModule $s.Modules 'Example.Graph' '2.0.0'
        New-InstalledModule $s.Modules 'Example.Exchange' '3.0.0'
        New-InstalledModule $s.Modules 'Stray.Module' '1.0.0'
        & $InstallScript -Destination $s.Modules -LockFile $s.LockFile
        Get-Tree $s.Modules | Should -Be @('Example.Exchange/3.1.0', 'Example.Graph/2.0.0', 'Pester/6.2.0')
        Should -Invoke Save-PSResource -Times 2 -Exactly
        Should -Invoke Save-PSResource -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'Example.Exchange' -and $Version -eq '3.1.0' -and $Repository -eq 'PSGallery' -and $SkipDependencyCheck -and $TrustRepository
        }
    }

    It 'installs only runtime modules with -Production, removing dev modules' {
        $s = New-Sandbox
        New-InstalledModule $s.Modules 'Pester' '6.2.0'
        & $InstallScript -Destination $s.Modules -LockFile $s.LockFile -Production
        Get-Tree $s.Modules | Should -Be @('Example.Exchange/3.1.0', 'Example.Graph/2.0.0')
    }

    It 'installs only the named modules with -Name and leaves the rest alone' {
        $s = New-Sandbox
        New-InstalledModule $s.Modules 'Stray.Module' '1.0.0'
        New-InstalledModule $s.Modules 'Pester' '5.7.1'
        & $InstallScript -Destination $s.Modules -LockFile $s.LockFile -Name Pester
        Get-Tree $s.Modules | Should -Be @('Pester/6.2.0', 'Stray.Module/1.0.0')
        Should -Invoke Save-PSResource -Times 1 -Exactly -ParameterFilter { $Name -eq 'Pester' }
    }

    It 'does nothing when every pin is already installed' {
        $s = New-Sandbox
        foreach ($pin in (Get-PinnedModule -Lock $Lock).GetEnumerator()) { New-InstalledModule $s.Modules $pin.Key $pin.Value }
        & $InstallScript -Destination $s.Modules -LockFile $s.LockFile
        Should -Invoke Save-PSResource -Times 0 -Exactly
        Get-Tree $s.Modules | Should -Be @('Example.Exchange/3.1.0', 'Example.Graph/2.0.0', 'Pester/6.2.0')
    }

    It 'fails when the gallery download does not produce the module manifest' {
        $s = New-Sandbox
        Mock Save-PSResource {}
        { & $InstallScript -Destination $s.Modules -LockFile $s.LockFile -Name Pester } | Should -Throw '*did not produce*Pester.psd1*'
    }
}

Describe 'Set-RunnerModulePath' {
    It 'puts the pinned modules first and keeps only PowerShell''s own modules after them' {
        $saved = $env:PSModulePath
        try {
            Set-RunnerModulePath -ModulesDir '/opt/adminforge/modules'
            $env:PSModulePath | Should -Be ('/opt/adminforge/modules' + [System.IO.Path]::PathSeparator + (Join-Path $PSHOME 'Modules'))
        } finally {
            $env:PSModulePath = $saved
        }
    }
}
