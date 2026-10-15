#Requires -Version 7.4
<#
    AdminForge.Runner — helpers for AdminForge runner scripts and the runner worker.

    Scripts use:   Write-AdminForgeLog, Write-AdminForgeProgress, Write-AdminForgeOutput,
                   Get-AdminForgeInput, New-AdminForgeError
    The worker uses: Set-AdminForgeEventSink, Send-AdminForgeEvent, Connect-AdminForgeServices,
                   Enable-AdminForgeReadOnlyMode, Send-AdminForgeStreamRecord, Get-AdminForgeErrorCategory

    Events are NDJSON objects (one per line) on the worker's protocol channel (stdout):
      {type:'log', level, message, ts} {type:'progress', percent, message} {type:'output', data}
      {type:'error', message, category}
#>
Set-StrictMode -Version Latest

$script:ErrorCategories = @('input', 'auth', 'readOnly', 'script', 'timeout', 'cancelled', 'runner', 'protocol')
$script:Mode = 'write'
$script:EventSink = $null
$script:EventWriter = $null

# Modules whose non-Get commands are blocked in read-only mode. tmpEXO_* is the module Exchange Online
# generates at connect time for its REST cmdlets.
$script:ReadOnlyModules = @('ExchangeOnlineManagement', 'tmpEXO_*', 'MicrosoftTeams', 'PnP.PowerShell')

#region Events

function ConvertTo-AdminForgeJson {
    param([Parameter(Mandatory)][AllowNull()]$InputObject)
    ConvertTo-Json -InputObject $InputObject -Depth 32 -Compress -EnumsAsStrings -WarningAction SilentlyContinue
}

function Set-AdminForgeEventSink {
    <#
    .SYNOPSIS
        Chooses where AdminForge events go: a TextWriter (the worker's protocol channel) or a script block
        that receives each event hashtable (tests).
    #>
    [CmdletBinding(DefaultParameterSetName = 'Writer')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Writer')][System.IO.TextWriter]$Writer,
        [Parameter(Mandatory, ParameterSetName = 'ScriptBlock')][scriptblock]$ScriptBlock,
        [Parameter(Mandatory, ParameterSetName = 'Reset')][switch]$Reset
    )
    $script:EventWriter = $null
    $script:EventSink = $null
    switch ($PSCmdlet.ParameterSetName) {
        'Writer' { $script:EventWriter = $Writer }
        'ScriptBlock' { $script:EventSink = $ScriptBlock }
    }
}

function Send-AdminForgeEvent {
    <# .SYNOPSIS Sends one event hashtable to the current sink (stdout as NDJSON by default). #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Event)
    if ($script:EventWriter) {
        $script:EventWriter.WriteLine((ConvertTo-AdminForgeJson $Event))
        $script:EventWriter.Flush()
    } elseif ($script:EventSink) {
        & $script:EventSink $Event
    } else {
        [Console]::Out.WriteLine((ConvertTo-AdminForgeJson $Event))
    }
}

function Write-AdminForgeLog {
    <#
    .SYNOPSIS
        Writes a log line to the job's event stream.
    .EXAMPLE
        Write-AdminForgeLog "Found $count mailboxes"
    .EXAMPLE
        Write-AdminForgeLog -Level Warn "Mailbox $id has no licence"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][AllowEmptyString()][string]$Message,
        [ValidateSet('Debug', 'Info', 'Warn', 'Error')][string]$Level = 'Info'
    )
    Send-AdminForgeEvent @{ type = 'log'; level = $Level.ToLowerInvariant(); message = $Message; ts = [DateTime]::UtcNow.ToString('o') }
}

function Write-AdminForgeProgress {
    <#
    .SYNOPSIS
        Reports progress (0-100) with a short message.
    .EXAMPLE
        Write-AdminForgeProgress -Percent 40 -Message 'Reading inbox rules'
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][ValidateRange(0, 100)][double]$Percent,
        [Parameter(Position = 1)][AllowEmptyString()][string]$Message = ''
    )
    Send-AdminForgeEvent @{ type = 'progress'; percent = [Math]::Round($Percent, 1, [MidpointRounding]::AwayFromZero); message = $Message }
}

function Write-AdminForgeOutput {
    <#
    .SYNOPSIS
        Emits structured output. One event per call (-Data) or one per pipeline item.
    .DESCRIPTION
        Values are serialised to JSON (depth 32, enums as strings). Project the properties you need with
        Select-Object first: live module objects (PnP, Exchange) can be deep or cyclic.
    .EXAMPLE
        Write-AdminForgeOutput -Data @{ total = $rows.Count; rows = $rows }
    .EXAMPLE
        $rows | Write-AdminForgeOutput
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, Position = 0, ValueFromPipeline)][AllowNull()][AllowEmptyCollection()]$Data)
    process {
        Send-AdminForgeEvent @{ type = 'output'; data = $Data }
    }
}

function Send-AdminForgeStreamRecord {
    <#
    .SYNOPSIS
        Routes one record of a script's merged output (*>&1) to an event: errors, warnings, verbose/debug and
        information records become log events; everything else is script output.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, ValueFromPipeline)][AllowNull()]$Record)
    process {
        switch ($Record) {
            { $_ -is [System.Management.Automation.ErrorRecord] } { Write-AdminForgeLog -Level Error -Message ([string]$_.Exception.Message); break }
            { $_ -is [System.Management.Automation.WarningRecord] } { Write-AdminForgeLog -Level Warn -Message $_.Message; break }
            { $_ -is [System.Management.Automation.VerboseRecord] -or $_ -is [System.Management.Automation.DebugRecord] } { Write-AdminForgeLog -Level Debug -Message $_.Message; break }
            { $_ -is [System.Management.Automation.InformationRecord] } { Write-AdminForgeLog -Level Info -Message ([string]$_.MessageData); break }
            default { Send-AdminForgeEvent @{ type = 'output'; data = $_ } }
        }
    }
}

#endregion

#region Errors and inputs

function New-AdminForgeError {
    <#
    .SYNOPSIS
        Creates an ErrorRecord carrying an AdminForge error category. Throw it from a script.
    .EXAMPLE
        throw (New-AdminForgeError -Category input -Message 'identity is required')
    #>
    [CmdletBinding()]
    [OutputType([System.Management.Automation.ErrorRecord])]
    param(
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('input', 'auth', 'readOnly', 'script', 'runner')][string]$Category = 'script',
        [string]$ErrorId = 'AdminForge.ScriptError',
        [object]$TargetObject
    )
    $exception = [System.InvalidOperationException]::new($Message)
    $exception.Data['AdminForge.Category'] = $Category
    $psCategory = switch ($Category) {
        'input' { [System.Management.Automation.ErrorCategory]::InvalidArgument }
        'auth' { [System.Management.Automation.ErrorCategory]::AuthenticationError }
        'readOnly' { [System.Management.Automation.ErrorCategory]::PermissionDenied }
        default { [System.Management.Automation.ErrorCategory]::NotSpecified }
    }
    [System.Management.Automation.ErrorRecord]::new($exception, $ErrorId, $psCategory, $TargetObject)
}

function Get-AdminForgeErrorCategory {
    <# .SYNOPSIS Maps an ErrorRecord (or exception) to an AdminForge error category. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowNull()]$ErrorRecord)
    $exception = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ErrorRecord.Exception } else { $ErrorRecord }
    while ($null -ne $exception) {
        if ($exception -is [System.Exception] -and $exception.Data.Contains('AdminForge.Category')) {
            $category = [string]$exception.Data['AdminForge.Category']
            if ($category -in $script:ErrorCategories) { return $category }
        }
        $exception = if ($exception -is [System.Exception]) { $exception.InnerException } else { $null }
    }
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord] -and $ErrorRecord.FullyQualifiedErrorId -like 'AdminForge.ReadOnlyMode*') { return 'readOnly' }
    'script'
}

function Get-AdminForgeInput {
    <#
    .SYNOPSIS
        Reads and validates one value from $Inputs. Throws an 'input' error when it is missing or invalid.
    .DESCRIPTION
        Inputs are data: they are validated and typed here and must never be pasted into script text or
        Invoke-Expression.
    .EXAMPLE
        $identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+$'
    .EXAMPLE
        $max = Get-AdminForgeInput $Inputs 'resultSize' -Type Int -Default 1000 -Minimum 1 -Maximum 50000
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][AllowNull()][System.Collections.IDictionary]$Inputs,
        [Parameter(Mandatory, Position = 1)][string]$Name,
        [ValidateSet('String', 'Int', 'Bool', 'StringArray', 'Object')][string]$Type = 'String',
        [switch]$Required,
        $Default,
        [string]$Pattern,
        [string[]]$AllowedValues,
        [long]$Minimum = [long]::MinValue,
        [long]$Maximum = [long]::MaxValue,
        [int]$MaxCount = 10000,
        [int]$MaxLength = 4096
    )
    $present = $null -ne $Inputs -and $Inputs.Contains($Name) -and $null -ne $Inputs[$Name] -and -not ($Inputs[$Name] -is [string] -and $Inputs[$Name] -eq '')
    if (-not $present) {
        if ($Required) { throw (New-AdminForgeError -Category input -Message "Input '$Name' is required." -ErrorId 'AdminForge.InputMissing') }
        if ($PSBoundParameters.ContainsKey('Default')) { return $Default }
        if ($Type -eq 'StringArray') { return , [string[]]@() }
        return $null
    }
    $value = $Inputs[$Name]
    $fail = { param($why) throw (New-AdminForgeError -Category input -Message "Input '$Name' $why" -ErrorId 'AdminForge.InputInvalid') }
    $checkString = {
        param([string]$s)
        if ($s.Length -gt $MaxLength) { & $fail "is longer than $MaxLength characters." }
        if ($Pattern -and $s -notmatch $Pattern) { & $fail 'has an invalid format.' }
        if ($AllowedValues -and $s -notin $AllowedValues) { & $fail "must be one of: $($AllowedValues -join ', ')." }
    }
    switch ($Type) {
        'String' {
            if ($value -isnot [string]) { & $fail 'must be a string.' }
            & $checkString $value
            return [string]$value
        }
        'Int' {
            if ($value -isnot [int] -and $value -isnot [long]) { & $fail 'must be a whole number.' }
            if ($value -lt $Minimum -or $value -gt $Maximum) {
                $range = if ($PSBoundParameters.ContainsKey('Minimum') -and $PSBoundParameters.ContainsKey('Maximum')) { "between $Minimum and $Maximum" }
                elseif ($PSBoundParameters.ContainsKey('Maximum')) { "at most $Maximum" } else { "at least $Minimum" }
                & $fail "must be $range."
            }
            return [long]$value
        }
        'Bool' {
            if ($value -isnot [bool]) { & $fail 'must be true or false.' }
            return [bool]$value
        }
        'StringArray' {
            if ($value -isnot [string] -and $value -isnot [System.Collections.IList]) { & $fail 'must be a list of strings.' }
            $items = @($value)
            if ($items.Count -gt $MaxCount) { & $fail "has more than $MaxCount entries." }
            foreach ($item in $items) {
                if ($item -isnot [string]) { & $fail 'must contain only strings.' }
                & $checkString $item
            }
            return , [string[]]$items
        }
        'Object' { return $value }
    }
}

#endregion

#region Connections

function Get-AdminForgeTokenClaims {
    <# Decodes (without validating) the payload of a JWT access token. Used only for labels such as the UPN. #>
    param([string]$Token)
    try {
        $parts = $Token.Split('.')
        if ($parts.Count -lt 2) { return @{} }
        $payload = $parts[1].Replace('-', '+').Replace('_', '/')
        switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } }
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
        ConvertFrom-Json -InputObject $json -AsHashtable
    } catch {
        @{}
    }
}

function Get-AdminForgeUserFromClaims {
    param([System.Collections.IDictionary]$Claims)
    $upn = $null
    foreach ($claim in 'upn', 'preferred_username', 'unique_name') {
        if ($Claims.Contains($claim) -and $Claims[$claim]) { $upn = [string]$Claims[$claim]; break }
    }
    $oid = if ($Claims.Contains('oid')) { [string]$Claims['oid'] } else { $null }
    @{ Upn = $upn; ObjectId = $oid }
}

function Connect-AdminForgeServices {
    <#
    .SYNOPSIS
        Connects the requested services with the calling engineer's forwarded delegated tokens.
    .DESCRIPTION
        $Context = @{
            Mode   = 'read' | 'write'
            Tenant = @{ id = '<guid>'; domain = 'contoso.onmicrosoft.com'; spoTenantName = 'contoso' }
            Tokens = @{ graph = '...'; exchange = '...'; teams = '...'; sharepointAdmin = '...'; arm = '...' }
        }
        Services and the tokens they need:
            Graph       graph                Connect-MgGraph -AccessToken <SecureString>
            Exchange    exchange             Connect-ExchangeOnline -AccessToken -Organization <tenant domain>
            Teams       graph + teams        Connect-MicrosoftTeams -AccessTokens @(graph, teams)
            SharePoint  sharepointAdmin      Connect-PnPOnline -Url https://<spoTenantName>-admin.sharepoint.com -AccessToken
            Az          arm                  Connect-AzAccount -AccessToken -AccountId <upn> -Tenant <id> -Scope Process
        Nothing is persisted: Az context autosave is disabled and the worker runs with a throw-away HOME.
        Returns @{ Services = <connected>; User = @{ Upn; ObjectId } }.
    .EXAMPLE
        Connect-AdminForgeServices -Context $ctx -Services Graph, Exchange
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Context,
        [Parameter(Mandatory)][ValidateSet('Graph', 'Exchange', 'Teams', 'SharePoint', 'Az')][string[]]$Services
    )
    $tokens = if ($Context.Contains('Tokens') -and $Context['Tokens']) { $Context['Tokens'] } else { @{} }
    $tenant = if ($Context.Contains('Tenant') -and $Context['Tenant']) { $Context['Tenant'] } else { @{} }
    $token = {
        param([string]$Name, [string]$Service)
        if (-not $tokens.Contains($Name) -or [string]::IsNullOrEmpty([string]$tokens[$Name])) {
            throw (New-AdminForgeError -Category auth -Message "$Service needs a '$Name' token, but none was forwarded for this job." -ErrorId 'AdminForge.TokenMissing')
        }
        [string]$tokens[$Name]
    }
    $tenantValue = {
        param([string]$Name, [string]$Service)
        if (-not $tenant.Contains($Name) -or [string]::IsNullOrEmpty([string]$tenant[$Name])) {
            throw (New-AdminForgeError -Category auth -Message "$Service needs tenant.$Name." -ErrorId 'AdminForge.TenantValueMissing')
        }
        [string]$tenant[$Name]
    }

    $user = @{ Upn = $null; ObjectId = $null }
    foreach ($name in 'graph', 'exchange', 'teams', 'sharepointAdmin', 'arm') {
        if ($tokens.Contains($name) -and $tokens[$name]) {
            $user = Get-AdminForgeUserFromClaims (Get-AdminForgeTokenClaims ([string]$tokens[$name]))
            if ($user.Upn -or $user.ObjectId) { break }
        }
    }

    $connected = [System.Collections.Generic.List[string]]::new()
    # SharePoint first: PnP.PowerShell must be imported before MicrosoftTeams (assembly resolver conflict).
    $order = 'SharePoint', 'Graph', 'Exchange', 'Teams', 'Az'
    foreach ($service in ($order | Where-Object { $_ -in $Services })) {
        try {
            switch ($service) {
                'Graph' {
                    $secure = ConvertTo-SecureString -String (& $token 'graph' 'Graph') -AsPlainText -Force
                    Connect-MgGraph -AccessToken $secure -NoWelcome -ErrorAction Stop | Out-Null
                }
                'Exchange' {
                    $params = @{
                        AccessToken           = (& $token 'exchange' 'Exchange Online')
                        Organization          = (& $tenantValue 'domain' 'Exchange Online')
                        ShowBanner            = $false
                        SkipLoadingFormatData = $true
                        SkipLoadingCmdletHelp = $true
                        ErrorAction           = 'Stop'
                    }
                    if ($user.Upn) { $params.UserPrincipalName = $user.Upn }
                    Connect-ExchangeOnline @params | Out-Null
                }
                'Teams' {
                    $teamsTokens = @((& $token 'graph' 'Microsoft Teams'), (& $token 'teams' 'Microsoft Teams'))
                    $params = @{ AccessTokens = $teamsTokens; ErrorAction = 'Stop' }
                    if ($tenant.Contains('id') -and $tenant['id']) { $params.TenantId = [string]$tenant['id'] }
                    Connect-MicrosoftTeams @params | Out-Null
                }
                'SharePoint' {
                    $name = & $tenantValue 'spoTenantName' 'SharePoint'
                    if ($name -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
                        throw (New-AdminForgeError -Category input -Message 'tenant.spoTenantName is not a valid SharePoint tenant name.')
                    }
                    Connect-PnPOnline -Url "https://$name-admin.sharepoint.com" -AccessToken (& $token 'sharepointAdmin' 'SharePoint') -ErrorAction Stop | Out-Null
                }
                'Az' {
                    $accountId = if ($user.Upn) { $user.Upn } elseif ($user.ObjectId) { $user.ObjectId } else { 'adminforge-user' }
                    Disable-AzContextAutosave -Scope Process -WarningAction SilentlyContinue | Out-Null
                    $params = @{
                        AccessToken   = (& $token 'arm' 'Azure')
                        AccountId     = $accountId
                        Scope         = 'Process'
                        ErrorAction   = 'Stop'
                        WarningAction = 'SilentlyContinue'
                    }
                    if ($tenant.Contains('id') -and $tenant['id']) { $params.Tenant = [string]$tenant['id'] }
                    Connect-AzAccount @params | Out-Null
                }
            }
            $connected.Add($service)
        } catch {
            $category = Get-AdminForgeErrorCategory $_
            if ($category -eq 'script') { $category = 'auth' }
            throw (New-AdminForgeError -Category $category -Message "Could not connect to ${service}: $($_.Exception.Message)" -ErrorId 'AdminForge.ConnectFailed')
        }
    }
    @{ Services = $connected.ToArray(); User = $user }
}

#endregion

#region Read-only mode

function New-AdminForgeReadOnlyBlock {
    param([string]$CommandName)
    $blocked = $CommandName
    {
        $ex = [System.InvalidOperationException]::new("'$blocked' is not allowed in read-only mode. Only Get-* commands are available; run a write-mode job (armed session) to make changes.")
        $ex.Data['AdminForge.Category'] = 'readOnly'
        throw [System.Management.Automation.ErrorRecord]::new($ex, 'AdminForge.ReadOnlyMode', [System.Management.Automation.ErrorCategory]::PermissionDenied, $blocked)
    }.GetNewClosure()
}

function New-AdminForgeGetOnlyProxy {
    # Proxy for a REST cmdlet (Invoke-MgGraphRequest, Invoke-AzRestMethod) that allows only -Method GET.
    param([System.Management.Automation.CommandInfo]$Command)
    $metadata = [System.Management.Automation.CommandMetadata]::new($Command)
    $proxy = [System.Management.Automation.ProxyCommand]::Create($metadata)
    $guard = @'
    if ($PSBoundParameters.ContainsKey('Method') -and ([string]$PSBoundParameters['Method']).ToUpperInvariant() -ne 'GET') {
        $ex = [System.InvalidOperationException]::new("$($MyInvocation.MyCommand.Name) -Method $($PSBoundParameters['Method']) is not allowed in read-only mode. Only GET requests are available; run a write-mode job (armed session) to make changes.")
        $ex.Data['AdminForge.Category'] = 'readOnly'
        throw [System.Management.Automation.ErrorRecord]::new($ex, 'AdminForge.ReadOnlyMode', [System.Management.Automation.ErrorCategory]::PermissionDenied, $null)
    }
'@
    $regex = [regex]::new('begin\s*\{')
    if (-not $regex.IsMatch($proxy)) { throw "Could not build a read-only proxy for $($Command.Name)" }
    [scriptblock]::Create($regex.Replace($proxy, "begin`n{`n$guard", 1))
}

function Set-AdminForgeGlobalFunction {
    param([string]$Name, [scriptblock]$Body)
    $existing = Get-Item -LiteralPath "function:$Name" -ErrorAction SilentlyContinue
    if ($existing -and ($existing.Options -band [System.Management.Automation.ScopedItemOptions]::Constant)) { return } # already guarded
    # Imported module functions and aliases live in the global scope; from here, the provider finds and removes those.
    if (Test-Path -LiteralPath "alias:$Name") { Remove-Item -LiteralPath "alias:$Name" -Force }
    if ($existing) { Remove-Item -LiteralPath "function:$Name" -Force }
    # Constant: a script cannot remove or redefine the guard.
    New-Item -Path 'function:' -Name "global:$Name" -Value $Body -Options Constant -Force | Out-Null
}

function Enable-AdminForgeReadOnlyMode {
    <#
    .SYNOPSIS
        Restricts the session to read operations.
    .DESCRIPTION
        - Every command exported by the Exchange Online (including its generated tmpEXO_* module), Teams and
          PnP modules whose verb is not Get is replaced by a constant function that throws
          "'<name>' is not allowed in read-only mode".
        - Unknown Verb-Noun commands with a non-Get verb (e.g. Exchange cmdlets that were not loaded) fail
          with the same message instead of "not recognized".
        - Invoke-MgGraphRequest and Invoke-AzRestMethod accept only -Method GET.
        This guards against mistakes in reviewed, sha256-pinned scripts; it is not a sandbox for hostile code
        (module-qualified names such as PnP.PowerShell\New-PnPList bypass the shadowing). Tokens from the
        Read app registration and the API's request policy remain the primary controls.
    #>
    [CmdletBinding()]
    param(
        [string[]]$ModuleName = $script:ReadOnlyModules,
        [switch]$SkipRestGuards
    )
    $script:Mode = 'read'
    $blocked = 0
    $modules = @(Get-Module -Name $ModuleName -ErrorAction SilentlyContinue)
    if ($modules.Count) {
        $commands = @(Get-Command -Module ($modules.Name | Select-Object -Unique) -ErrorAction SilentlyContinue)
        foreach ($command in $commands) {
            $verb = ($command.Name -split '-', 2)[0]
            if ($verb -eq 'Get') { continue }
            Set-AdminForgeGlobalFunction -Name $command.Name -Body (New-AdminForgeReadOnlyBlock -CommandName $command.Name)
            $blocked++
        }
    }

    if (-not $SkipRestGuards) {
        $rest = @(
            @{ Module = 'Microsoft.Graph.Authentication'; Name = 'Invoke-MgGraphRequest'; Aliases = @('Invoke-GraphRequest', 'Invoke-MgRestMethod') }
            @{ Module = 'Az.Accounts'; Name = 'Invoke-AzRestMethod'; Aliases = @('Invoke-AzRest') }
        )
        foreach ($entry in $rest) {
            if (-not (Get-Module -Name $entry.Module)) { continue }
            $command = Get-Command -Name "$($entry.Module)\$($entry.Name)" -CommandType Cmdlet -ErrorAction SilentlyContinue
            if (-not $command) { continue }
            $proxy = New-AdminForgeGetOnlyProxy -Command $command
            foreach ($name in @($entry.Name) + $entry.Aliases) { Set-AdminForgeGlobalFunction -Name $name -Body $proxy }
        }
    }

    $ExecutionContext.InvokeCommand.CommandNotFoundAction = {
        param([string]$CommandName, [System.Management.Automation.CommandLookupEventArgs]$EventArgs)
        $name = ($CommandName -split '\\')[-1]
        if ($name -match '^(?<verb>[A-Za-z]+)-[A-Za-z0-9]+$' -and $Matches['verb'] -ne 'Get') {
            $EventArgs.CommandScriptBlock = New-AdminForgeReadOnlyBlock -CommandName $name
            $EventArgs.StopSearch = $true
        }
    }
    Write-Verbose "Read-only mode: blocked $blocked commands"
    $blocked
}

function Get-AdminForgeMode {
    <# .SYNOPSIS Returns 'read' after Enable-AdminForgeReadOnlyMode, otherwise 'write'. #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $script:Mode
}

#endregion

Export-ModuleMember -Function @(
    'Set-AdminForgeEventSink', 'Send-AdminForgeEvent', 'Send-AdminForgeStreamRecord',
    'Write-AdminForgeLog', 'Write-AdminForgeProgress', 'Write-AdminForgeOutput',
    'New-AdminForgeError', 'Get-AdminForgeErrorCategory', 'Get-AdminForgeInput',
    'Connect-AdminForgeServices', 'Enable-AdminForgeReadOnlyMode', 'Get-AdminForgeMode'
)
