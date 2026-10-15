#Requires -Version 7.4
# The read-only policy of the runner: the static check before a read-mode script runs (Test-AdminForgeReadOnlyScript)
# and the session guards while it runs (Enable-AdminForgeReadOnlyMode). Run with tests/runner/pester/run.ps1.

BeforeDiscovery {
    $modulesRoot = if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { $env:ADMINFORGE_RUNNER_MODULES_DIR } else { Join-Path $PSScriptRoot '../../../portal/apps/runner/modules' }
    $graphInstalled = Test-Path (Join-Path $modulesRoot 'Microsoft.Graph.Authentication')
    $azInstalled = Test-Path (Join-Path $modulesRoot 'Az.Accounts')
    $scriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/content/scripts')).Path
    # Read scripts declare "Mode: read" in their help notes.
    $readScripts = @(Get-ChildItem -Path $scriptsRoot -Filter *.ps1 -Recurse | Where-Object {
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$null)
            $help = $ast.GetHelpContent()
            $help -and $help.Notes -match 'Mode:\s*read'
        } | ForEach-Object { @{ Name = $_.FullName.Substring($scriptsRoot.Length + 1); Path = $_.FullName } })

    $refused = @(
        @{ Code = 'ExchangeOnlineManagement\Set-Mailbox -Identity someone -Type Shared'; Text = 'ExchangeOnlineManagement\Set-Mailbox' }
        @{ Code = 'PnP.PowerShell\New-PnPList -Title x -Template GenericList'; Text = 'PnP.PowerShell\New-PnPList' }
        @{ Code = 'MicrosoftTeams\Set-CsTeamsMeetingPolicy -Identity Global'; Text = 'MicrosoftTeams\Set-CsTeamsMeetingPolicy' }
        @{ Code = "Microsoft.Graph.Authentication\Invoke-MgGraphRequest -Method POST -Uri '/v1.0/users'"; Text = 'Microsoft.Graph.Authentication\Invoke-MgGraphRequest' }
        @{ Code = "Az.Accounts\Invoke-AzRestMethod -Method PUT -Path '/x'"; Text = 'Az.Accounts\Invoke-AzRestMethod' }
        @{ Code = "Get-Date | ForEach-Object { ExchangeOnlineManagement\Remove-Mailbox -Identity x }"; Text = 'ExchangeOnlineManagement\Remove-Mailbox' }
        @{ Code = "function Get-Helper { PnP.PowerShell\Remove-PnPSite -Url x }"; Text = 'PnP.PowerShell\Remove-PnPSite' }
        @{ Code = "Invoke-RestMethod -Method Post -Uri 'https://graph.microsoft.com/v1.0/users'"; Text = 'Invoke-RestMethod' }
        @{ Code = "Invoke-WebRequest 'https://example.com'"; Text = 'Invoke-WebRequest' }
        @{ Code = "Invoke-Expression 'Set-Mailbox x'"; Text = 'Invoke-Expression' }
        @{ Code = "iex 'Set-Mailbox x'"; Text = 'iex' }
        @{ Code = "Add-Type -TypeDefinition 'public class X {}'"; Text = 'Add-Type' }
        @{ Code = 'New-Object System.Net.WebClient'; Text = 'New-Object' }
        @{ Code = 'Import-Module ./Evil.psm1'; Text = 'Import-Module' }
        @{ Code = 'Start-ThreadJob { Get-Date }'; Text = 'Start-ThreadJob' }
        @{ Code = 'Start-Job { Get-Date }'; Text = 'Start-Job' }
        @{ Code = 'Get-Content /etc/hostname'; Text = 'Get-Content' }
        @{ Code = 'Get-Variable -Name ExecutionContext -ValueOnly'; Text = 'Get-Variable' }
        @{ Code = 'Set-Alias -Name x -Value Set-Mailbox'; Text = 'Set-Alias' }
        @{ Code = 'Get-AzAccessToken'; Text = 'Get-AzAccessToken' }
        @{ Code = 'Get-PnPAccessToken'; Text = 'Get-PnPAccessToken' }
        @{ Code = 'Get-PnPContext'; Text = 'Get-PnPContext' }
        @{ Code = "Send-WorkerLine @{ type = 'exit'; status = 'succeeded' }"; Text = 'Send-WorkerLine' }
        @{ Code = 'Connect-AdminForgeServices -Context @{} -Services Graph'; Text = 'Connect-AdminForgeServices' }
        @{ Code = '$c = "Set-Mailbox"; & $c -Identity x'; Text = '& $c -Identity x' }
        @{ Code = "& ('Set-' + 'Mailbox') -Identity x"; Text = "& ('Set-' + 'Mailbox') -Identity x" }
        @{ Code = '$sb = { 1 }; . $sb'; Text = '. $sb' }
        @{ Code = './Other.ps1'; Text = './Other.ps1' }
        @{ Code = '/bin/sh -c id'; Text = '/bin/sh' }
        @{ Code = "[scriptblock]::Create('Set-Mailbox x')"; Text = '[scriptblock]' }
        @{ Code = '[System.Net.WebClient]::new()'; Text = '[System.Net.WebClient]' }
        @{ Code = "[type]'System.Net.WebClient'"; Text = '[type]' }
        @{ Code = '$t = "System.Net.WebClient"; @{} -as $t'; Text = '@{} -as $t' }
        @{ Code = '$x = Get-Date; $x::new()'; Text = '$x::new()' }
        @{ Code = "`$ExecutionContext.InvokeCommand.InvokeScript('x')"; Text = '$ExecutionContext' }
        @{ Code = '$global:ExecutionContext'; Text = '$ExecutionContext' }
        @{ Code = '$Host.Runspace'; Text = '$Host' }
        @{ Code = '$PSCmdlet.SessionState'; Text = '$PSCmdlet' }
        @{ Code = '${function:Set-Mailbox}'; Text = '${function:Set-Mailbox}' }
        @{ Code = "`$env:HTTPS_PROXY = 'http://proxy.example'"; Text = '$env:HTTPS_PROXY' }
        @{ Code = "`$PSModuleAutoLoadingPreference = 'All'"; Text = '$PSModuleAutoLoadingPreference' }
        @{ Code = 'function f { param($PSModuleAutoLoadingPreference = "All") }'; Text = '$PSModuleAutoLoadingPreference' }
        @{ Code = '{ Get-Date }.Invoke()'; Text = '.Invoke' }
        @{ Code = "'x'.GetType()"; Text = '.GetType' }
        @{ Code = 'Get-PnPWeb | ForEach-Object { $_.Context.ExecuteQuery() }'; Text = '.Context' }
        @{ Code = 'Get-PnPWeb | ForEach-Object ExecuteQuery'; Text = '.ExecuteQuery' }
        @{ Code = 'Get-PnPWeb | ForEach-Object -MemberName $m'; Text = 'ForEach-Object -MemberName $m' }
        @{ Code = '@(1).ForEach("Invoke")'; Text = '.Invoke' }
        @{ Code = '$o = Get-Date; $m = "AddDays"; $o.$m(1)'; Text = '$o.$m(1)' }
        @{ Code = '1..3 | ForEach-Object -Parallel { Get-Date }'; Text = 'ForEach-Object -Parallel' }
        @{ Code = '1..3 | ForEach-Object -AsJob { Get-Date }'; Text = 'ForEach-Object -AsJob' }
        @{ Code = 'Get-ChildItem ~/.config'; Text = 'Get-ChildItem ~/.config' }
        @{ Code = 'Get-ChildItem'; Text = 'Get-ChildItem' }
        @{ Code = 'class Evil { }'; Text = 'class Evil' }
        @{ Code = "using namespace System.Net`n[WebClient]::new()"; Text = 'using namespace System.Net' }
        @{ Code = "#Requires -Modules Az.Resources`nGet-Date"; Text = '#Requires' }
    )

    $allowed = @(
        @{ Code = 'Get-EXOMailbox -ResultSize 10 | Select-Object DisplayName, PrimarySmtpAddress' }
        @{ Code = 'ExchangeOnlineManagement\Get-EXOMailbox -ResultSize 1' }
        @{ Code = 'Microsoft.PowerShell.Utility\Select-Object -InputObject 1' }
        @{ Code = "Set-Mailbox -Identity x # unqualified service write: refused at the call by the session guard" }
        @{ Code = "Invoke-MgGraphRequest -Method GET -Uri '/v1.0/me' # GET-only proxy at run time" }
        @{ Code = 'function Join-Short($Values) { $Values -join "," }; Join-Short @(1, 2)' }
        @{ Code = '$list = [System.Collections.Generic.List[object]]::new(); $list.Add(1); $list.ToArray()' }
        @{ Code = "[Math]::Floor(1.5); [regex]::Match('a@b.example', '@.+').Value.ToLowerInvariant(); ([datetime]'2026-01-01').ToUniversalTime().ToString('o')" }
        @{ Code = 'Get-ChildItem env: | ForEach-Object Name | Sort-Object' }
        @{ Code = '@(1, 2) | ForEach-Object { $_ * 2 } | Where-Object { $_ -gt 2 } | Measure-Object' }
        @{ Code = "`$h = [ordered]@{ a = 1 }; `$h.Contains('a'); `$h.Keys.Count" }
        @{ Code = '$u = [pscustomobject]@{ A = 1 }; $t = "A"; $u.$t; $u.PSObject.Properties["A"]' }
        @{ Code = "`$Context['Mode']; Get-AdminForgeInput `$Inputs 'x' -Default 1 | Write-AdminForgeOutput" }
        @{ Code = "try { throw (New-AdminForgeError -Category input -Message 'x') } catch { Write-AdminForgeLog `$_.Exception.Message }" }
        @{ Code = "[System.Convert]::ToBoolean('true'); [string]::IsNullOrWhiteSpace(' ')" }
        @{ Code = '[CmdletBinding()] param([hashtable]$Inputs = @{}, [hashtable]$Context = @{}) Set-StrictMode -Version Latest; $ErrorActionPreference = "Stop"' }
    )
}

BeforeAll {
    $script:RunnerRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/apps/runner')).Path
    $script:ModulePath = Join-Path $RunnerRoot 'ps/AdminForge.Runner/AdminForge.Runner.psd1'
    $script:ModulesDir = if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { $env:ADMINFORGE_RUNNER_MODULES_DIR } else { Join-Path $RunnerRoot 'modules' }
    Import-Module $ModulePath -Force

    function Test-ModuleInstalled([string]$Name) {
        [bool](Get-ChildItem -Path (Join-Path $ModulesDir $Name) -Filter "$Name.psd1" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
    }

    function Invoke-Worker([hashtable]$Job) {
        $env:ADMINFORGE_RUNNER_PRELOAD = 'none'
        try {
            $lines = (ConvertTo-Json -InputObject $Job -Depth 10 -Compress) | & pwsh -NoLogo -NoProfile -NonInteractive -File (Join-Path $RunnerRoot 'ps/worker.ps1') 2>$null
        } finally {
            Remove-Item Env:ADMINFORGE_RUNNER_PRELOAD -ErrorAction SilentlyContinue
        }
        @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json -AsHashtable })
    }
    function New-Job([string]$Mode, [string]$Content) {
        @{
            jobId = 'pester-policy'; mode = $Mode; inputs = @{}; tokens = @{}; timeoutSeconds = 60
            script = @{ path = 'pester/Policy.ps1'; sha256 = ('0' * 64); content = $Content }
            tenant = @{ id = '0f3a4c2e-8b1d-4e6f-9a7c-2d5b8e1f4a63'; domain = 'example.onmicrosoft.com' }
        }
    }
}

Describe 'Static read-only policy' {
    It '<Name> may run in read mode' -ForEach $readScripts {
        $findings = @(Test-AdminForgeReadOnlyScript -Content (Get-Content -Raw -LiteralPath $Path))
        ($findings | ForEach-Object Message) | Should -BeNullOrEmpty
    }

    It 'refuses <Code>' -ForEach $refused {
        $findings = @(Test-AdminForgeReadOnlyScript -Content $Code)
        $findings.Count | Should -BeGreaterThan 0
        $finding = $findings | Where-Object { $_.Text -eq $Text -or $_.Text -like "$Text*" } | Select-Object -First 1
        $finding | Should -Not -BeNullOrEmpty -Because "a finding for '$Text' (got: $($findings.Text -join ' | '))"
        $finding.Message | Should -BeLike "'*' is not allowed in read-only mode. * (line $($finding.Line))"
    }

    It 'allows <Code>' -ForEach $allowed {
        (@(Test-AdminForgeReadOnlyScript -Content $Code) | ForEach-Object Message) | Should -BeNullOrEmpty
    }

    It 'reports the line of each violation, in order' {
        $code = "Get-Date`nInvoke-RestMethod x`n`$x = 1`nPnP.PowerShell\New-PnPList -Title x"
        $findings = @(Test-AdminForgeReadOnlyScript -Content $code)
        $findings.Line | Should -Be @(2, 4)
        $findings[0].Message | Should -Be "'Invoke-RestMethod' is not allowed in read-only mode. Read-only scripts can call Get-* commands of the connected services and a fixed set of helpers; changes need a write-mode playbook step (armed session). (line 2)"
    }

    It 'leaves scripts that do not parse to the worker (it reports the parse error)' {
        @(Test-AdminForgeReadOnlyScript -Content 'function {') | Should -BeNullOrEmpty
    }

    It 'Assert-AdminForgeReadOnlyScript throws a readOnly error for the first violation' {
        $caught = $null
        try { Assert-AdminForgeReadOnlyScript -Content "Get-Date`nExchangeOnlineManagement\Set-Mailbox -Identity x" } catch { $caught = $_ }
        Get-AdminForgeErrorCategory $caught | Should -Be 'readOnly'
        $caught.Exception.Message | Should -BeLike "'ExchangeOnlineManagement\Set-Mailbox' is not allowed in read-only mode.*(line 2)"
        { Assert-AdminForgeReadOnlyScript -Content 'Get-Date' } | Should -Not -Throw
    }
}

Describe 'worker.ps1 applies the policy before the script runs' {
    It 'refuses a module-qualified write in read mode, before connecting or running anything' {
        $content = "[CmdletBinding()] param([hashtable]`$Inputs, [hashtable]`$Context)`nWrite-AdminForgeOutput -Data 'ran'`nExchangeOnlineManagement\Set-Mailbox -Identity someone -Type Shared"
        $job = New-Job 'read' $content
        # A token for a service that would fail to connect: the policy refuses first, so no auth error appears.
        $job.tokens = @{ sharepointAdmin = 'x' * 40 }
        $events = Invoke-Worker $job
        $err = @($events | Where-Object type -EQ 'error')
        $err.Count | Should -Be 1
        $err[0].category | Should -Be 'readOnly'
        $err[0].message | Should -BeLike "'ExchangeOnlineManagement\Set-Mailbox' is not allowed in read-only mode.*(line 3)"
        $events | Where-Object type -EQ 'output' | Should -BeNullOrEmpty
        $events[-1].status | Should -Be 'failed'
    }

    It 'refuses parallel runspaces in read mode' {
        $events = Invoke-Worker (New-Job 'read' '1..2 | ForEach-Object -Parallel { Get-Date }')
        ($events | Where-Object type -EQ 'error').category | Should -Be 'readOnly'
    }

    It 'does not apply the policy in write mode' {
        $events = Invoke-Worker (New-Job 'write' "Write-AdminForgeOutput -Data 'ran'`nExchangeOnlineManagement\Set-Mailbox -Identity someone")
        ($events | Where-Object type -EQ 'output').data | Should -Be 'ran'
        ($events | Where-Object type -EQ 'error').category | Should -Be 'script' -Because 'the module is not loaded in the test worker'
    }
}

Describe 'Session guards in read mode (Enable-AdminForgeReadOnlyMode)' {
    BeforeAll {
        $graph = Test-ModuleInstalled 'Microsoft.Graph.Authentication'
        $az = Test-ModuleInstalled 'Az.Accounts'
        # An on-disk module that is NOT loaded when read mode starts: with auto-loading off it stays unloaded.
        $widgetRoot = Join-Path $TestDrive 'modules'
        New-Item -ItemType Directory -Force -Path (Join-Path $widgetRoot 'Widget') | Out-Null
        Set-Content -LiteralPath (Join-Path $widgetRoot 'Widget/Widget.psm1') -Value "function Get-Widget { 'widget' }`nfunction Set-Widget { 'WIDGET SET' }"
        $load = @()
        if ($graph) { $load += 'Microsoft.Graph.Authentication' }
        if ($az) { $load += 'Az.Accounts' }
        $file = Join-Path $TestDrive 'guards.ps1'
        Set-Content -LiteralPath $file -Value @"
`$ErrorActionPreference = 'Stop'
`$env:PSModulePath = '$ModulesDir' + [IO.Path]::PathSeparator + '$widgetRoot' + [IO.Path]::PathSeparator + (Join-Path `$PSHOME 'Modules')
Import-Module '$ModulePath'
$(if ($load) { "Import-Module $($load -join ', ') -WarningAction SilentlyContinue *> `$null" })
New-Module -Name FakeWorkload -ScriptBlock {
    function Get-Thing { 'got' }
    function Set-Thing { 'SET RAN' }
    Set-Alias -Name Read-Thing -Value Set-Thing
    Export-ModuleMember -Function * -Alias *
} | Import-Module
function Out-Result([string]`$Name, [scriptblock]`$Action) {
    try { `$value = & `$Action; '{0}|ok|{1}' -f `$Name, `$value }
    catch { '{0}|{1}|{2}' -f `$Name, (Get-AdminForgeErrorCategory `$_), `$_.Exception.Message.Split("``n")[0] }
}
`$null = Enable-AdminForgeReadOnlyMode
Out-Result 'autoload' { `$PSModuleAutoLoadingPreference }
Out-Result 'get' { Get-Thing }
Out-Result 'set' { Set-Thing }
Out-Result 'alias-to-write' { Read-Thing }
Out-Result 'core' { (Get-Date -Year 2026 -Month 1 -Day 2).ToString('yyyy') }
Out-Result 'unloaded-write' { Set-Widget }
Out-Result 'unloaded-read' { Get-Widget }
if (Get-Module Microsoft.Graph.Authentication) {
    Out-Result 'graph-connect' { Connect-MgGraph -AccessToken (ConvertTo-SecureString 'x' -AsPlainText -Force) }
    Out-Result 'graph-post' { Invoke-MgGraphRequest -Method POST -Uri '/v1.0/users' -Body @{} }
}
if (Get-Module Az.Accounts) {
    Out-Result 'az-set' { Set-AzContext -Subscription x }
    Out-Result 'az-rest' { Invoke-AzRestMethod -Method PUT -Path '/x' -Payload '{}' }
}
"@
        $lines = & pwsh -NoLogo -NoProfile -NonInteractive -File $file 2>&1
        $result = @{}
        foreach ($l in $lines) { $parts = ([string]$l) -split '\|', 3; if ($parts.Count -eq 3) { $result[$parts[0]] = @{ status = $parts[1]; message = $parts[2] } } }
    }

    It 'turns module auto-loading off' {
        $result['autoload'].message | Should -Be 'None'
    }

    It 'guards every loaded service module by default (no module list), and aliases to its writes' {
        $result['get'].message | Should -Be 'got'
        foreach ($name in 'set', 'alias-to-write') {
            $result[$name].status | Should -Be 'readOnly' -Because $name
            $result[$name].message | Should -Match 'not allowed in read-only mode'
        }
    }

    It "leaves PowerShell's own commands alone" {
        $result['core'].message | Should -Be '2026'
    }

    It 'does not load a module for a call: an unloaded write is read-only, an unloaded read is not found' {
        $result['unloaded-write'].status | Should -Be 'readOnly'
        $result['unloaded-write'].message | Should -BeLike "'Set-Widget' is not allowed in read-only mode*"
        $result['unloaded-read'].status | Should -Be 'script'
        $result['unloaded-read'].message | Should -Match 'not recognized'
    }

    It 'guards Microsoft Graph' -Skip:(-not $graphInstalled) {
        $result['graph-connect'].status | Should -Be 'readOnly'
        $result['graph-post'].status | Should -Be 'readOnly'
    }

    It 'guards Az' -Skip:(-not $azInstalled) {
        $result['az-set'].status | Should -Be 'readOnly'
        $result['az-rest'].status | Should -Be 'readOnly'
        $result['az-rest'].message | Should -Match 'PUT is not allowed in read-only mode'
    }
}
