#Requires -Version 7.4
# Pester tests for the AdminForge.Runner module and worker.ps1. Run with tests/runner/pester/run.ps1.

BeforeAll {
    $script:RunnerRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/apps/runner')).Path
    $script:ModulePath = Join-Path $RunnerRoot 'ps/AdminForge.Runner/AdminForge.Runner.psd1'
    $script:ModulesDir = if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { $env:ADMINFORGE_RUNNER_MODULES_DIR } else { Join-Path $RunnerRoot 'modules' }
    Import-Module $ModulePath -Force

    # A syntactically valid, unsigned JWT with synthetic claims (never a real token).
    function New-FakeToken([string]$Upn = 'engineer@example.com') {
        $enc = { param($o) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress))).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
        '{0}.{1}.{2}' -f (& $enc @{ alg = 'RS256'; typ = 'JWT' }), (& $enc @{ upn = $Upn; oid = '6a1c1f8e-3c55-4c0e-9d1e-5b8d2b4f7a10'; aud = 'test' }), 'c2lnbmF0dXJl'
    }

    # Runs PowerShell code in a fresh pwsh (read-only mode changes global session state) and returns stdout lines.
    function Invoke-Isolated([string]$Code) {
        $file = Join-Path $TestDrive "isolated-$([guid]::NewGuid().ToString('N')).ps1"
        $prologue = @"
`$ErrorActionPreference = 'Stop'
`$env:PSModulePath = '$ModulesDir' + [IO.Path]::PathSeparator + (Join-Path `$PSHOME 'Modules')
Import-Module '$ModulePath'
"@
        Set-Content -LiteralPath $file -Value ($prologue + "`n" + $Code)
        $out = & pwsh -NoLogo -NoProfile -NonInteractive -File $file 2>&1
        @($out | ForEach-Object { [string]$_ })
    }

    function Test-ModuleInstalled([string]$Name) {
        [bool](Get-ChildItem -Path (Join-Path $ModulesDir $Name) -Filter "$Name.psd1" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
    }
}

Describe 'Event helpers' {
    BeforeEach {
        $events = [System.Collections.Generic.List[object]]::new()
        Set-AdminForgeEventSink -ScriptBlock { param($e) $events.Add($e) }.GetNewClosure()
    }
    AfterAll { Set-AdminForgeEventSink -Reset }

    It 'Write-AdminForgeLog emits a log event with a lower-case level and an ISO timestamp' {
        Write-AdminForgeLog -Level Warn 'careful'
        $events.Count | Should -Be 1
        $events[0].type | Should -Be 'log'
        $events[0].level | Should -Be 'warn'
        $events[0].message | Should -Be 'careful'
        { [datetime]::Parse($events[0].ts) } | Should -Not -Throw
    }

    It 'Write-AdminForgeProgress emits progress and rejects values outside 0-100' {
        Write-AdminForgeProgress -Percent 42.25 -Message 'half-ish'
        $events[0] | Should -Not -BeNullOrEmpty
        $events[0].type | Should -Be 'progress'
        $events[0].percent | Should -Be 42.3
        { Write-AdminForgeProgress -Percent 101 } | Should -Throw
    }

    It 'Write-AdminForgeOutput emits one event for -Data and one per pipeline item' {
        Write-AdminForgeOutput -Data @(1, 2, 3)
        @(4, 5) | Write-AdminForgeOutput
        $events.Count | Should -Be 3
        $events[0].data | Should -Be @(1, 2, 3)
        $events[1].data | Should -Be 4
        $events[2].data | Should -Be 5
    }

    It 'Send-AdminForgeStreamRecord routes PowerShell streams to log levels and objects to output' {
        & {
            Write-Warning 'w'
            Write-Information 'i' -InformationAction Continue
            Write-Error 'e' -ErrorAction Continue
            [pscustomobject]@{ name = 'row' }
        } *>&1 | Send-AdminForgeStreamRecord
        ($events | ForEach-Object { if ($_.type -eq 'log') { "log:$($_.level):$($_.message)" } else { "output:$($_.data.name)" } }) |
            Should -Be @('log:warn:w', 'log:info:i', 'log:error:e', 'output:row')
    }

    It 'a writer sink produces one compact JSON object per line' {
        $writer = [System.IO.StringWriter]::new()
        Set-AdminForgeEventSink -Writer $writer
        Write-AdminForgeLog 'one'
        Write-AdminForgeOutput -Data @{ nested = @{ list = @(1, 2) } }
        $lines = $writer.ToString().Trim() -split "`r?`n"
        $lines.Count | Should -Be 2
        ($lines[1] | ConvertFrom-Json -AsHashtable).data.nested.list | Should -Be @(1, 2)
    }
}

Describe 'Get-AdminForgeInput' {
    BeforeAll {
        $inputs = '{"name":"user@example.com","count":5,"flag":true,"list":["a","b"],"single":"x","empty":""}' | ConvertFrom-Json -AsHashtable
    }

    It 'returns typed values' {
        Get-AdminForgeInput $inputs 'name' -Pattern '^[^@]+@[^@]+$' | Should -Be 'user@example.com'
        Get-AdminForgeInput $inputs 'count' -Type Int -Maximum 10 | Should -Be 5
        Get-AdminForgeInput $inputs 'flag' -Type Bool | Should -BeTrue
    }

    It 'returns string arrays, wrapping a single string' {
        $list = Get-AdminForgeInput $inputs 'list' -Type StringArray
        $list.GetType().Name | Should -Be 'String[]'
        $list.Count | Should -Be 2
        (Get-AdminForgeInput $inputs 'single' -Type StringArray).Count | Should -Be 1
        (Get-AdminForgeInput $inputs 'missing' -Type StringArray).Count | Should -Be 0
    }

    It 'applies defaults to missing and empty values' {
        Get-AdminForgeInput $inputs 'missing' -Default 'fallback' | Should -Be 'fallback'
        Get-AdminForgeInput $inputs 'empty' -Default 'fallback' | Should -Be 'fallback'
    }

    It 'throws input errors for missing, mistyped and invalid values' {
        $cases = @(
            { Get-AdminForgeInput $inputs 'nope' -Required }
            { Get-AdminForgeInput $inputs 'name' -Type Int }
            { Get-AdminForgeInput $inputs 'count' -Type Int -Maximum 3 }
            { Get-AdminForgeInput $inputs 'name' -Pattern '^\d+$' }
            { Get-AdminForgeInput $inputs 'single' -AllowedValues 'a', 'b' }
            { Get-AdminForgeInput $inputs 'list' -Type StringArray -MaxCount 1 }
        )
        foreach ($case in $cases) {
            $caught = $null
            try { & $case } catch { $caught = $_ }
            $caught | Should -Not -BeNullOrEmpty
            Get-AdminForgeErrorCategory $caught | Should -Be 'input'
            $caught.Exception.Message | Should -Match "^Input '"
        }
    }
}

Describe 'Error categories' {
    It 'round-trips a category through New-AdminForgeError' {
        try { throw (New-AdminForgeError -Category auth -Message 'no token') } catch { Get-AdminForgeErrorCategory $_ | Should -Be 'auth' }
    }
    It 'finds a category on an inner exception' {
        $inner = [InvalidOperationException]::new('inner')
        $inner.Data['AdminForge.Category'] = 'readOnly'
        Get-AdminForgeErrorCategory ([Exception]::new('outer', $inner)) | Should -Be 'readOnly'
    }
    It 'treats anything else as a script error' {
        try { throw 'plain' } catch { Get-AdminForgeErrorCategory $_ | Should -Be 'script' }
    }
}

Describe 'Connect-AdminForgeServices' {
    BeforeAll {
        # PnP before Teams (assembly resolver conflict); fall back to stubs when the modules are not installed.
        foreach ($module in 'PnP.PowerShell', 'Microsoft.Graph.Authentication', 'ExchangeOnlineManagement', 'MicrosoftTeams', 'Az.Accounts') {
            if (Test-ModuleInstalled $module) { Import-Module $module -ErrorAction SilentlyContinue -WarningAction SilentlyContinue }
        }
        $stubs = @{
            'Connect-MgGraph'           = { param([securestring]$AccessToken, [switch]$NoWelcome) }
            'Connect-ExchangeOnline'    = { param([string]$AccessToken, [string]$Organization, [string]$UserPrincipalName, [switch]$ShowBanner, [switch]$SkipLoadingFormatData, [switch]$SkipLoadingCmdletHelp) }
            'Connect-MicrosoftTeams'    = { param([string[]]$AccessTokens, [string]$TenantId) }
            'Connect-PnPOnline'         = { param([string]$Url, [string]$AccessToken) }
            'Disable-AzContextAutosave' = { param([string]$Scope) }
            'Connect-AzAccount'         = { param([string]$AccessToken, [string]$AccountId, [string]$Tenant, [string]$Scope) }
        }
        foreach ($name in $stubs.Keys) {
            if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Set-Item -Path "function:global:$name" -Value $stubs[$name] }
        }
        $token = New-FakeToken
        $tenantInfo = @{ id = '0f3a4c2e-8b1d-4e6f-9a7c-2d5b8e1f4a63'; domain = 'example.onmicrosoft.com'; spoTenantName = 'example' }
    }

    BeforeEach {
        Mock -ModuleName AdminForge.Runner Connect-MgGraph {}
        Mock -ModuleName AdminForge.Runner Connect-ExchangeOnline {}
        Mock -ModuleName AdminForge.Runner Connect-MicrosoftTeams {}
        Mock -ModuleName AdminForge.Runner Connect-PnPOnline {}
        Mock -ModuleName AdminForge.Runner Disable-AzContextAutosave {}
        Mock -ModuleName AdminForge.Runner Connect-AzAccount {}
    }

    It 'connects Graph with the token as a SecureString and no welcome banner' {
        $result = Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ graph = $token } } -Services Graph
        $result.Services | Should -Be @('Graph')
        $result.User.Upn | Should -Be 'engineer@example.com'
        Should -Invoke -ModuleName AdminForge.Runner Connect-MgGraph -Times 1 -Exactly -ParameterFilter {
            $NoWelcome -and [System.Net.NetworkCredential]::new('', $AccessToken).Password -eq $token
        }
    }

    It 'connects Exchange Online with -AccessToken and -Organization' {
        Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ exchange = $token } } -Services Exchange | Out-Null
        Should -Invoke -ModuleName AdminForge.Runner Connect-ExchangeOnline -Times 1 -Exactly -ParameterFilter {
            $AccessToken -eq $token -and $Organization -eq 'example.onmicrosoft.com' -and $UserPrincipalName -eq 'engineer@example.com' -and -not $ShowBanner
        }
    }

    It 'connects Teams with the Graph and Teams tokens' {
        $teamsToken = New-FakeToken 'other@example.com'
        Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ graph = $token; teams = $teamsToken } } -Services Teams | Out-Null
        Should -Invoke -ModuleName AdminForge.Runner Connect-MicrosoftTeams -Times 1 -Exactly -ParameterFilter {
            $AccessTokens.Count -eq 2 -and $AccessTokens[0] -eq $token -and $AccessTokens[1] -eq $teamsToken -and $TenantId -eq $tenantInfo.id
        }
    }

    It 'connects SharePoint admin with the tenant admin URL' {
        Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ sharepointAdmin = $token } } -Services SharePoint | Out-Null
        Should -Invoke -ModuleName AdminForge.Runner Connect-PnPOnline -Times 1 -Exactly -ParameterFilter {
            $Url -eq 'https://example-admin.sharepoint.com' -and $AccessToken -eq $token
        }
    }

    It 'connects Az for this process only, with the UPN as the account id' {
        Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ arm = $token } } -Services Az | Out-Null
        Should -Invoke -ModuleName AdminForge.Runner Disable-AzContextAutosave -Times 1 -Exactly -ParameterFilter { $Scope -eq 'Process' }
        Should -Invoke -ModuleName AdminForge.Runner Connect-AzAccount -Times 1 -Exactly -ParameterFilter {
            $AccessToken -eq $token -and $AccountId -eq 'engineer@example.com' -and $Tenant -eq $tenantInfo.id -and $Scope -eq 'Process'
        }
    }

    It 'refuses a service whose token was not forwarded, without calling it' {
        { Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ graph = $token } } -Services Exchange } |
            Should -Throw -ExpectedMessage "*needs a 'exchange' token*"
        Should -Invoke -ModuleName AdminForge.Runner Connect-ExchangeOnline -Times 0 -Exactly
    }

    It 'refuses Teams without the Graph token' {
        { Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ teams = $token } } -Services Teams } |
            Should -Throw -ExpectedMessage "*needs a 'graph' token*"
    }

    It 'validates the SharePoint tenant name before building a URL from it' {
        $bad = @{ id = $tenantInfo.id; domain = $tenantInfo.domain; spoTenantName = 'evil.example.net/x' }
        $caught = $null
        try { Connect-AdminForgeServices -Context @{ Tenant = $bad; Tokens = @{ sharepointAdmin = $token } } -Services SharePoint } catch { $caught = $_ }
        Get-AdminForgeErrorCategory $caught | Should -Be 'input'
        Should -Invoke -ModuleName AdminForge.Runner Connect-PnPOnline -Times 0 -Exactly
    }

    It 'reports connection failures as auth errors without echoing the token' {
        Mock -ModuleName AdminForge.Runner Connect-MgGraph { throw 'service said no' }
        $caught = $null
        try { Connect-AdminForgeServices -Context @{ Tenant = $tenantInfo; Tokens = @{ graph = $token } } -Services Graph } catch { $caught = $_ }
        Get-AdminForgeErrorCategory $caught | Should -Be 'auth'
        $caught.Exception.Message | Should -Be 'Could not connect to Graph: service said no'
        $caught.Exception.Message | Should -Not -Match ([regex]::Escape($token))
    }
}

Describe 'Read-only mode' {
    BeforeDiscovery {
        $modulesRoot = if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { $env:ADMINFORGE_RUNNER_MODULES_DIR } else { Join-Path $PSScriptRoot '../../../portal/apps/runner/modules' }
        $pnp = Test-Path (Join-Path $modulesRoot 'PnP.PowerShell')
        $teams = Test-Path (Join-Path $modulesRoot 'MicrosoftTeams')
        $graph = Test-Path (Join-Path $modulesRoot 'Microsoft.Graph.Authentication')
    }
    BeforeAll {
        $pnp = Test-ModuleInstalled 'PnP.PowerShell'
        $teams = Test-ModuleInstalled 'MicrosoftTeams'
        $graph = Test-ModuleInstalled 'Microsoft.Graph.Authentication'
        $probe = @'
function Out-Result([string]$Name, [scriptblock]$Action) {
    try { $value = & $Action; '{0}|ok|{1}' -f $Name, $value }
    catch { '{0}|{1}|{2}' -f $Name, (Get-AdminForgeErrorCategory $_), $_.Exception.Message.Split("`n")[0] }
}
New-Module -Name FakeWorkload -ScriptBlock {
    function Get-Thing { 'got' }
    function Set-Thing { 'SET RAN' }
    function New-Thing { 'NEW RAN' }
    Set-Alias -Name Update-Thing -Value Set-Thing
    Export-ModuleMember -Function * -Alias *
} | Import-Module
'@
        $modulesToLoad = @()
        if ($pnp) { $modulesToLoad += 'PnP.PowerShell' }
        if ($teams) { $modulesToLoad += 'MicrosoftTeams' }
        if ($graph) { $modulesToLoad += 'Microsoft.Graph.Authentication' }
        $load = if ($modulesToLoad) { "Import-Module $($modulesToLoad -join ', ') -WarningAction SilentlyContinue *> `$null" } else { '' }

        $readLines = Invoke-Isolated ($probe + "`n" + $load + @'

$null = Enable-AdminForgeReadOnlyMode -ModuleName FakeWorkload, PnP.PowerShell, MicrosoftTeams
Out-Result 'mode' { Get-AdminForgeMode }
Out-Result 'get' { Get-Thing }
Out-Result 'set' { Set-Thing }
Out-Result 'alias' { Update-Thing }
Out-Result 'new-in-scriptblock' { & ([scriptblock]::Create('New-Thing')) }
Out-Result 'not-loaded-write' { Set-Mailbox -Identity someone }
Out-Result 'not-loaded-read' { Get-Mailbox -Identity someone }
Out-Result 'remove-guard' { Remove-Item function:Set-Thing -Force; 'removed' }
if (Get-Module PnP.PowerShell) { Out-Result 'pnp-write' { New-PnPList -Title x -Template GenericList } }
if (Get-Module MicrosoftTeams) { Out-Result 'teams-write' { Set-CsTeamsMeetingPolicy -Identity Global } }
if (Get-Module Microsoft.Graph.Authentication) {
    Out-Result 'graph-post' { Invoke-MgGraphRequest -Method POST -Uri '/v1.0/users' -Body @{} }
    Out-Result 'graph-get' { Invoke-MgGraphRequest -Method GET -Uri '/v1.0/me' }
}
'@)
        $read = @{}
        foreach ($l in $readLines) { $parts = $l -split '\|', 3; if ($parts.Count -eq 3) { $read[$parts[0]] = @{ status = $parts[1]; message = $parts[2] } } }

        $writeLines = Invoke-Isolated ($probe + @'

Out-Result 'mode' { Get-AdminForgeMode }
Out-Result 'set' { Set-Thing }
'@)
        $write = @{}
        foreach ($l in $writeLines) { $parts = $l -split '\|', 3; if ($parts.Count -eq 3) { $write[$parts[0]] = @{ status = $parts[1]; message = $parts[2] } } }
    }

    It 'switches the session to read mode' {
        $read['mode'].message | Should -Be 'read'
    }

    It 'keeps Get-* commands callable' {
        $read['get'].status | Should -Be 'ok'
        $read['get'].message | Should -Be 'got'
    }

    It 'blocks Set-*, New-* and aliases to them with a clear error' {
        foreach ($name in 'set', 'alias', 'new-in-scriptblock') {
            $read[$name].status | Should -Be 'readOnly' -Because $name
            $read[$name].message | Should -Match 'not allowed in read-only mode'
        }
    }

    It 'reports write commands of modules that are not loaded (e.g. Set-Mailbox) as read-only, not "not recognized"' {
        $read['not-loaded-write'].status | Should -Be 'readOnly'
        $read['not-loaded-write'].message | Should -BeLike "'Set-Mailbox' is not allowed in read-only mode*"
        $read['not-loaded-read'].status | Should -Be 'script'
        $read['not-loaded-read'].message | Should -Match 'not recognized'
    }

    It 'cannot be undone by the script' {
        $read['remove-guard'].status | Should -Not -Be 'ok'
        $read['remove-guard'].message | Should -Match 'constant'
    }

    It 'blocks real PnP write cmdlets' -Skip:(-not $pnp) {
        $read['pnp-write'].status | Should -Be 'readOnly'
        $read['pnp-write'].message | Should -BeLike "'New-PnPList' is not allowed in read-only mode*"
    }

    It 'blocks real Teams write cmdlets' -Skip:(-not $teams) {
        $read['teams-write'].status | Should -Be 'readOnly'
    }

    It 'allows only GET through Invoke-MgGraphRequest' -Skip:(-not $graph) {
        $read['graph-post'].status | Should -Be 'readOnly'
        $read['graph-post'].message | Should -Match 'POST is not allowed in read-only mode'
        $read['graph-get'].status | Should -Be 'script' -Because 'GET passes the guard and fails later only because nothing is connected'
    }

    It 'leaves write mode unrestricted' {
        $write['mode'].message | Should -Be 'write'
        $write['set'].status | Should -Be 'ok'
        $write['set'].message | Should -Be 'SET RAN'
    }
}

Describe 'worker.ps1' {
    BeforeAll {
        $worker = Join-Path $RunnerRoot 'ps/worker.ps1'
        function Invoke-Worker([hashtable]$Job, [string]$Preload = 'none') {
            $env:ADMINFORGE_RUNNER_PRELOAD = $Preload
            try {
                $lines = (ConvertTo-Json -InputObject $Job -Depth 10 -Compress) | & pwsh -NoLogo -NoProfile -NonInteractive -File $worker 2>$null
            } finally {
                Remove-Item Env:ADMINFORGE_RUNNER_PRELOAD -ErrorAction SilentlyContinue
            }
            @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json -AsHashtable })
        }
        function New-Job([string]$Mode, [string]$Content, [hashtable]$Inputs = @{}) {
            @{
                jobId = 'pester-1'; mode = $Mode; inputs = $Inputs; tokens = @{}; timeoutSeconds = 60
                script = @{ path = 'pester/Test.ps1'; sha256 = ('0' * 64); content = $Content }
                tenant = @{ id = '0f3a4c2e-8b1d-4e6f-9a7c-2d5b8e1f4a63'; domain = 'example.onmicrosoft.com' }
            }
        }
    }

    It 'reports ready, runs the job with inputs as data, and exits succeeded' {
        $content = @'
[CmdletBinding()] param([hashtable]$Inputs, [hashtable]$Context)
Set-StrictMode -Version Latest
Write-AdminForgeLog "mode=$($Context.Mode)"
Write-AdminForgeOutput -Data @{ echoed = $Inputs.text; services = @($Context.Services) }
'@
        $events = Invoke-Worker (New-Job 'read' $content @{ text = '$(Get-Process); ; Remove-Item /' })
        $events[0].type | Should -Be 'ready'
        $events[0].pwsh | Should -Not -BeNullOrEmpty
        ($events | Where-Object type -EQ 'log').message | Should -Contain 'mode=read'
        ($events | Where-Object type -EQ 'output').data.echoed | Should -Be '$(Get-Process); ; Remove-Item /'
        $events[-1].type | Should -Be 'exit'
        $events[-1].status | Should -Be 'succeeded'
    }

    It 'fails a read-mode script that calls Set-Mailbox with a read-only error and the script line' {
        $content = "[CmdletBinding()] param([hashtable]`$Inputs, [hashtable]`$Context)`nSet-StrictMode -Version Latest`nSet-Mailbox -Identity someone -Type Shared"
        $events = Invoke-Worker (New-Job 'read' $content)
        $err = $events | Where-Object type -EQ 'error'
        $err.category | Should -Be 'readOnly'
        $err.message | Should -BeLike "'Set-Mailbox' is not allowed in read-only mode*(line 3)"
        $events[-1].status | Should -Be 'failed'
    }

    It 'reports a missing token as an auth error before running the script' {
        $job = New-Job 'read' "Write-AdminForgeOutput -Data 'should not run'"
        $job.tokens = @{ sharepointAdmin = (New-FakeToken) }
        $events = Invoke-Worker $job
        $err = $events | Where-Object type -EQ 'error'
        $err.category | Should -Be 'auth'
        $err.message | Should -Match 'spoTenantName'
        $events | Where-Object type -EQ 'output' | Should -BeNullOrEmpty
    }

    It 'exits quietly when stdin closes without a job' {
        $empty = Join-Path $TestDrive 'empty.txt'
        $out = Join-Path $TestDrive 'out.txt'
        Set-Content -LiteralPath $empty -Value $null -NoNewline
        $env:ADMINFORGE_RUNNER_PRELOAD = 'none'
        try {
            $process = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $worker `
                -RedirectStandardInput $empty -RedirectStandardOutput $out -Wait -PassThru
        } finally { Remove-Item Env:ADMINFORGE_RUNNER_PRELOAD }
        $process.ExitCode | Should -Be 0
        $lines = @(Get-Content -LiteralPath $out | Where-Object { $_ })
        $lines.Count | Should -Be 1
        ($lines[0] | ConvertFrom-Json).type | Should -Be 'ready'
    }
}
