#Requires -Version 7.4
# The AdminForge.Runner module is one .psm1 that dot-sources a file per concern (Events, Errors, Inputs, Connections,
# ReadOnlyPolicy). These tests keep that layout honest: the manifest and the module export the same functions, every
# concern file is loaded (and no stray .ps1 sits in the module folder unloaded), and every function the module defines
# comes from one of those files. Run with tests/runner/pester/run.ps1.

BeforeAll {
    $script:ModuleDir = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/apps/runner/ps/AdminForge.Runner')).Path
    $script:Manifest = Import-PowerShellDataFile -LiteralPath (Join-Path $ModuleDir 'AdminForge.Runner.psd1')
    $script:Module = Import-Module (Join-Path $ModuleDir 'AdminForge.Runner.psd1') -Force -PassThru
    $script:Concerns = @('Events.ps1', 'Errors.ps1', 'Inputs.ps1', 'Connections.ps1', 'ReadOnlyPolicy.ps1')

    function Get-ExportModuleMemberList {
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $ModuleDir 'AdminForge.Runner.psm1'), [ref]$null, [ref]$null)
        $call = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Export-ModuleMember' }, $true) | Select-Object -First 1
        @($call.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.StringConstantType -ne 'BareWord' }, $true).Value)
    }
}

Describe 'AdminForge.Runner module layout' {
    It 'exports exactly the functions the manifest lists' {
        @($Module.ExportedFunctions.Keys | Sort-Object) | Should -Be @($Manifest.FunctionsToExport | Sort-Object)
    }

    It 'lists the same functions in Export-ModuleMember as in the manifest' {
        @(Get-ExportModuleMemberList | Sort-Object) | Should -Be @($Manifest.FunctionsToExport | Sort-Object)
    }

    It 'dot-sources every concern file, and the module folder holds no other script' {
        $psm1 = Get-Content -Raw -LiteralPath (Join-Path $ModuleDir 'AdminForge.Runner.psm1')
        foreach ($file in $Concerns) { $psm1 | Should -Match ([regex]::Escape("'$file'")) }
        @(Get-ChildItem -LiteralPath $ModuleDir -Filter '*.ps1' -File | ForEach-Object Name | Sort-Object) | Should -Be @($Concerns | Sort-Object)
    }

    It 'defines every function in one of the concern files' {
        $functions = & $Module { Get-ChildItem function: | Where-Object ModuleName -eq 'AdminForge.Runner' }
        $functions.Count | Should -BeGreaterThan 20
        foreach ($f in $functions) {
            [System.IO.Path]::GetFileName($f.ScriptBlock.File) | Should -BeIn $Concerns -Because "$($f.Name) belongs to a concern file"
        }
    }

    It 'keeps the read-only policy and runtime guards in ReadOnlyPolicy.ps1' {
        foreach ($name in 'Test-AdminForgeReadOnlyScript', 'Assert-AdminForgeReadOnlyScript', 'Enable-AdminForgeReadOnlyMode', 'Get-AdminForgeMode') {
            [System.IO.Path]::GetFileName((Get-Command -Module AdminForge.Runner -Name $name).ScriptBlock.File) | Should -Be 'ReadOnlyPolicy.ps1'
        }
    }
}
