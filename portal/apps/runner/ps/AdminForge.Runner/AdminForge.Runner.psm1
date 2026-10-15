#Requires -Version 7.4
<#
    AdminForge.Runner — helpers for AdminForge runner scripts and the runner worker.

    Scripts use:   Write-AdminForgeLog, Write-AdminForgeProgress, Write-AdminForgeOutput,
                   Get-AdminForgeInput, New-AdminForgeError
    The worker uses: Set-AdminForgeEventSink, Send-AdminForgeEvent, Connect-AdminForgeServices,
                   Test-AdminForgeReadOnlyScript, Enable-AdminForgeReadOnlyMode, Send-AdminForgeStreamRecord,
                   Get-AdminForgeErrorCategory

    Events are NDJSON objects (one per line) on the worker's protocol channel (stdout):
      {type:'log', level, message, ts} {type:'progress', percent, message} {type:'output', data}
      {type:'error', message, category}
#>
Set-StrictMode -Version Latest

$script:ErrorCategories = @('input', 'auth', 'readOnly', 'script', 'timeout', 'cancelled', 'runner', 'protocol')
$script:Mode = 'write'
$script:EventSink = $null
$script:EventWriter = $null


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

<#
    Read-mode jobs run with the engineer's Read-app tokens, and some of those can write (Exchange.Manage, SharePoint
    AllSites.FullControl). Two layers keep a read-mode script to reads:

    1. Before the script runs (Test-AdminForgeReadOnlyScript): a static policy over the parsed script. Allowed are
       Get-* commands, the AdminForge script helpers, a fixed set of PowerShell utilities and the script's own
       functions. Refused before anything connects: module-qualified names of any other command
       (ExchangeOnlineManagement\Set-Mailbox), PowerShell's own commands outside the allow-list (Invoke-RestMethod,
       Invoke-Expression, Add-Type, New-Object, Import-Module, Start-ThreadJob, Get-Content …), dynamic invocation
       (& $x, . $x), scripts and programs by path, Get-* commands that hand out tokens or live connections, .NET types
       outside a small allow-list, reflection and invocation members (.Invoke(), .GetType(), .ExecuteQuery() …), the
       engine variables ($ExecutionContext, $Host, $PSCmdlet), provider variables (${function:…}, $env:…), classes and
       using statements.
    2. While it runs (Enable-AdminForgeReadOnlyMode): every non-Get command of every loaded service module
       (Exchange Online, its tmpEXO_* module, Teams, PnP, Microsoft Graph, Az …) is replaced by a constant guard,
       Invoke-MgGraphRequest / Invoke-AzRestMethod accept only GET, unknown non-Get commands fail as read-only, and
       module auto-loading is off. Unqualified service write commands (Set-Mailbox) are refused here, at the call.

    Write-mode jobs run without either layer. This is not a full sandbox: the script runs in FullLanguage (the
    existing read scripts need .NET collections and [Math], which ConstrainedLanguage refuses), so the static
    policy is the boundary. See docs/backlog.md (constrained runspace).
#>

# Script API of this module; everything else it exports is for the worker.
$script:ScriptHelpers = @(
    'Write-AdminForgeLog', 'Write-AdminForgeProgress', 'Write-AdminForgeOutput', 'Get-AdminForgeInput',
    'New-AdminForgeError', 'Get-AdminForgeMode'
)
$script:InternalCommands = @(
    'Set-AdminForgeEventSink', 'Send-AdminForgeEvent', 'Send-AdminForgeStreamRecord', 'Get-AdminForgeErrorCategory',
    'Connect-AdminForgeServices', 'Enable-AdminForgeReadOnlyMode', 'Test-AdminForgeReadOnlyScript',
    'Assert-AdminForgeReadOnlyScript',
    # worker.ps1 defines these in the scope the job script runs in.
    'Send-WorkerLine', 'Send-WorkerError', 'Exit-Worker'
)
# PowerShell's own commands a read-mode script may call; every other command PowerShell ships is refused.
$script:ReadOnlyCoreCommands = @(
    'ForEach-Object', 'Where-Object', 'Select-Object', 'Sort-Object', 'Group-Object', 'Measure-Object', 'Compare-Object',
    'Get-Unique', 'Get-Member', 'Start-Sleep', 'Get-Date', 'New-TimeSpan', 'Get-Random', 'Join-String',
    'ConvertTo-Json', 'ConvertFrom-Json', 'ConvertTo-Csv', 'ConvertFrom-Csv', 'Out-String', 'Out-Null',
    'Write-Output', 'Write-Verbose', 'Write-Debug', 'Write-Warning', 'Write-Information', 'Write-Error', 'Write-Host',
    'Set-StrictMode', 'Get-ChildItem'
)
$script:ReadOnlyAliases = @{
    '%' = 'ForEach-Object'; 'foreach' = 'ForEach-Object'; '?' = 'Where-Object'; 'where' = 'Where-Object'
    'select' = 'Select-Object'; 'sort' = 'Sort-Object'; 'group' = 'Group-Object'; 'measure' = 'Measure-Object'
    'sleep' = 'Start-Sleep'; 'echo' = 'Write-Output'
}
# Get-* commands that hand out tokens, credentials or live client objects (which can write).
$script:ReadOnlyDeniedGetPattern = '(?i)token|credential|secret|password'
$script:ReadOnlyDeniedGetCommands = @('Get-PnPConnection', 'Get-PnPContext', 'Get-ConnectionInformation', 'Get-AzContext')
# .NET types a read-mode script may name (lower case, without "system."); generic arguments are checked too.
$script:ReadOnlyTypes = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
        'string', 'char', 'bool', 'boolean', 'byte', 'sbyte', 'int', 'int16', 'int32', 'int64', 'uint16', 'uint32',
        'uint64', 'long', 'short', 'ushort', 'uint', 'ulong', 'double', 'single', 'float', 'decimal', 'bigint',
        'numerics.biginteger', 'datetime', 'datetimeoffset', 'timespan', 'guid', 'regex', 'text.regularexpressions.regex',
        'text.regularexpressions.regexoptions', 'text.regularexpressions.match', 'math', 'ordered', 'hashtable',
        'collections.hashtable', 'array', 'object', 'psobject', 'pscustomobject', 'management.automation.psobject',
        'management.automation.pscustomobject', 'collections.generic.list', 'collections.generic.hashset',
        'collections.generic.dictionary', 'collections.generic.sortedset', 'collections.generic.sorteddictionary',
        'collections.generic.queue', 'collections.generic.stack', 'collections.arraylist', 'collections.idictionary',
        'collections.ilist', 'collections.icollection', 'collections.ienumerable',
        'collections.specialized.ordereddictionary', 'stringcomparison', 'stringcomparer', 'midpointrounding',
        'text.stringbuilder', 'globalization.cultureinfo', 'cultureinfo', 'globalization.datetimestyles',
        'net.webutility', 'convert', 'uri', 'version', 'void', 'switch',
        'management.automation.switchparameter', 'mailaddress', 'net.mail.mailaddress', 'ipaddress', 'net.ipaddress',
        'management.automation.errorrecord', 'exception', 'invalidoperationexception', 'argumentexception'
    ), [System.StringComparer]::OrdinalIgnoreCase)
# Members that run code, reflect, reach the engine, or commit/send through client objects.
$script:ReadOnlyDeniedMethodPattern = '(?i)^(invoke\w*|begininvoke|endinvoke|dynamicinvoke|gettype|get(method|constructor|field|property|member|event|nestedtype|interface)s?|createinstance\w*|createdelegate|makegeneric(type|method)|new(bound)?scriptblock|getnewclosure|getpowershell|getsteppablepipeline|getcommand\w*|getcmdlet\w*|executequery\w*|add(command|script|statement|parameters?|argument)|start|kill|send\w*|upload\w*|download\w*|getresponse\w*|getrequeststream\w*|\w+async)$'
$script:ReadOnlyDeniedMembers = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
        'SessionState', 'InvokeCommand', 'InvokeProvider', 'PSVariable', 'Runspace', 'RunspacePool', 'Context', 'Host'
    ), [System.StringComparer]::OrdinalIgnoreCase)
$script:ReadOnlyDeniedVariables = @('ExecutionContext', 'Host', 'PSCmdlet', 'PSModuleAutoLoadingPreference')

# Every command PowerShell itself ships (core cmdlets, built-in aliases/functions, the modules under $PSHOME).
# Computed once at import: later, module auto-loading may be off.
$script:PowerShellCommands = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($entry in [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2().Commands) { [void]$script:PowerShellCommands.Add($entry.Name) }
$script:PowerShellModuleNames = @(Get-ChildItem -LiteralPath (Join-Path $PSHOME 'Modules') -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
if ($script:PowerShellModuleNames.Count) {
    foreach ($command in @(Get-Command -Module $script:PowerShellModuleNames -ErrorAction SilentlyContinue)) { [void]$script:PowerShellCommands.Add($command.Name) }
}

function Test-AdminForgePowerShellModule {
    # True for PowerShell's own modules (under $PSHOME) and the core snap-in.
    param([AllowNull()][System.Management.Automation.PSModuleInfo]$Module)
    if (-not $Module) { return $false }
    if ($Module.Name -eq 'Microsoft.PowerShell.Core') { return $true }
    $base = [string]$Module.ModuleBase
    [bool]($base -and $base.StartsWith($PSHOME, [System.StringComparison]::OrdinalIgnoreCase))
}

function Test-AdminForgeReadOnlyType {
    param([System.Management.Automation.Language.ITypeName]$TypeName)
    if ($TypeName -is [System.Management.Automation.Language.ArrayTypeName]) { return Test-AdminForgeReadOnlyType $TypeName.ElementType }
    if ($TypeName -is [System.Management.Automation.Language.GenericTypeName]) {
        if (-not (Test-AdminForgeReadOnlyType $TypeName.TypeName)) { return $false }
        foreach ($argument in $TypeName.GenericArguments) { if (-not (Test-AdminForgeReadOnlyType $argument)) { return $false } }
        return $true
    }
    $name = ([string]$TypeName.Name).Trim()
    if ($name.StartsWith('System.', [System.StringComparison]::OrdinalIgnoreCase)) { $name = $name.Substring(7) }
    $script:ReadOnlyTypes.Contains($name)
}

function Get-AdminForgeReadOnlyCommandProblem {
    # $null when the command may appear in a read-mode script (it may still be refused at the call by the guard);
    # otherwise why not.
    param([string]$Name, [System.Collections.Generic.HashSet[string]]$Defined)
    $why = 'Read-only scripts can call Get-* commands of the connected services and a fixed set of helpers; changes need a write-mode playbook step (armed session).'
    if ($Name -match '[/:~]' -or $Name.StartsWith('.') -or $Name.StartsWith('\') -or ($Name -split '\\').Count -gt 2 -or $Name -match '(?i)\.(ps1|psm1|psd1|exe|dll|sh|cmd|bat)$') {
        return "Read-only scripts can't run other scripts or programs."
    }
    $qualified = $Name.Contains('\')
    $bare = ($Name -split '\\')[-1]
    if (-not $qualified -and $Defined.Contains($bare)) { return $null }
    if (-not $qualified -and $script:ReadOnlyAliases.ContainsKey($bare)) { return $null }
    if ($bare -in $script:ScriptHelpers -or $bare -in $script:ReadOnlyCoreCommands) { return $null }
    if ($bare -in $script:InternalCommands) { return $why }
    if ($bare -match '^Get-[A-Za-z0-9]+$') {
        if ($bare -match $script:ReadOnlyDeniedGetPattern -or $bare -in $script:ReadOnlyDeniedGetCommands) {
            return "Read-only scripts can't read tokens, credentials or live connections."
        }
        if ($script:PowerShellCommands.Contains($bare)) { return $why }
        return $null
    }
    # Service write commands by plain name are left to the guards (refused at the call, see Enable-AdminForgeReadOnlyMode).
    if ($qualified -or $bare -notmatch '^[A-Za-z]+-[A-Za-z0-9]+$' -or $script:PowerShellCommands.Contains($bare)) { return $why }
    $null
}

function Test-AdminForgeReadOnlyScript {
    <#
    .SYNOPSIS
        Checks a script against the read-only policy before it runs. Returns one finding per violation, in script
        order (@{ Line; Column; Text; Message }), or nothing when the script may run in read mode.
    .DESCRIPTION
        See the region comment above for what is allowed. Scripts that do not parse return nothing (running them
        reports the parse error). Message reads "'<construct>' is not allowed in read-only mode. <why> (line N)".
    .EXAMPLE
        Test-AdminForgeReadOnlyScript -Content (Get-Content -Raw ./Get-Thing.ps1)
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Content)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Content, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { return }

    $defined = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        [void]$defined.Add(($f.Name -split ':', 2)[-1])
    }
    $findings = [System.Collections.Generic.List[object]]::new()
    $flag = {
        param($Node, [string]$Text, [string]$Why)
        $line = $Node.Extent.StartLineNumber
        if ($Text.Length -gt 80) { $Text = $Text.Substring(0, 77) + '...' }
        $findings.Add([pscustomobject]@{
                Line    = $line
                Column  = $Node.Extent.StartColumnNumber
                Text    = $Text
                Message = "'$Text' is not allowed in read-only mode. $Why (line $line)"
            })
    }
    $codeWhy = "Read-only scripts can't run code, use reflection or send requests through .NET objects."
    $checkMember = {
        param($Node, $Member, [bool]$Invoked)
        if ($Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
            if ($Invoked) { & $flag $Node $Node.Extent.Text 'Methods must be called by name in read-only mode.' }
            return
        }
        $name = $Member.Value
        if ($script:ReadOnlyDeniedMembers.Contains($name) -or ($Invoked -and $name -match $script:ReadOnlyDeniedMethodPattern)) {
            & $flag $Node ".$name" $codeWhy
        }
    }

    $reqs = $ast.ScriptRequirements
    if ($reqs -and (($reqs.RequiredModules -and $reqs.RequiredModules.Count) -or ($reqs.RequiredAssemblies -and $reqs.RequiredAssemblies.Count))) {
        & $flag $ast '#Requires' "Read-only scripts can't load modules or assemblies."
    }

    foreach ($node in $ast.FindAll({ $true }, $true)) {
        switch ($node.GetType().Name) {
            'CommandAst' {
                $first = $node.CommandElements[0]
                if ($first -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { break }
                if ($first -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Commands must be called by name in read-only mode.'
                    break
                }
                $name = $first.Value
                $problem = Get-AdminForgeReadOnlyCommandProblem -Name $name -Defined $defined
                if ($problem) { & $flag $node $name $problem; break }
                $bare = ($name -split '\\')[-1]
                $canonical = if ($script:ReadOnlyAliases.ContainsKey($bare) -and -not $defined.Contains($bare)) { $script:ReadOnlyAliases[$bare] } else { $bare }
                if ($defined.Contains($bare)) { break }
                $elements = @($node.CommandElements | Select-Object -Skip 1)
                if ($canonical -eq 'ForEach-Object') {
                    # Positional 0 / -MemberName names a property or method; -Parallel and -AsJob run in other runspaces.
                    $checkMemberElement = {
                        param($Element)
                        if ($Element -is [System.Management.Automation.Language.StringConstantExpressionAst]) { & $checkMember $node $Element $true }
                        elseif ($Element -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
                            & $flag $node $node.Extent.Text 'Methods must be called by name in read-only mode.'
                        }
                    }
                    $switches = 'AsJob', 'UseNewRunspace', 'WhatIf', 'Confirm', 'Verbose', 'Debug'
                    $positional = 0
                    $i = 0
                    while ($i -lt $elements.Count) {
                        $element = $elements[$i]
                        if ($element -isnot [System.Management.Automation.Language.CommandParameterAst]) {
                            if ($positional -eq 0) { & $checkMemberElement $element }
                            $positional++
                            $i++
                            continue
                        }
                        $p = $element.ParameterName
                        $startsWith = { param($Full) $p.Length -ge 2 -and $Full.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase) }
                        if ((& $startsWith 'Parallel') -or (& $startsWith 'AsJob') -or (& $startsWith 'UseNewRunspace')) {
                            & $flag $element "ForEach-Object -$p" 'Parallel and background execution is not allowed in read-only mode.'
                        }
                        $isMember = $p.Length -ge 1 -and 'MemberName'.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
                        $isSwitch = @($switches | Where-Object { $p.Length -ge 1 -and $_.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
                        if ($element.Argument) {
                            if ($isMember) { & $checkMemberElement $element.Argument }
                            $i++
                        } elseif ($isSwitch) {
                            $i++
                        } else {
                            if ($isMember -and $i + 1 -lt $elements.Count) { & $checkMemberElement $elements[$i + 1] }
                            $i += 2
                        }
                    }
                } elseif ($canonical -eq 'Get-ChildItem') {
                    $paths = 0
                    $bad = $false
                    $expectPath = $false
                    foreach ($element in $elements) {
                        if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
                            if ($element.ParameterName -notin 'Path', 'LiteralPath', 'Name') { $bad = $true; break }
                            if ($element.ParameterName -eq 'Name') { continue }
                            if ($element.Argument) {
                                if ($element.Argument -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $element.Argument.Value -match '^(?i)env:[\\/]?$') { $paths++ } else { $bad = $true; break }
                            } else { $expectPath = $true }
                            continue
                        }
                        $expectPath = $false
                        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $element.Value -match '^(?i)env:[\\/]?$') { $paths++ } else { $bad = $true; break }
                    }
                    if ($bad -or $expectPath -or $paths -eq 0) {
                        & $flag $node $node.Extent.Text 'Get-ChildItem can list only env: in read-only mode.'
                    }
                }
            }
            'InvokeMemberExpressionAst' {
                if ($node.Static -and $node.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Static members can be used only on a type name in read-only mode.'
                    break
                }
                & $checkMember $node $node.Member $true
                if ($node.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Member.Value -in 'ForEach', 'Where' -and @($node.Arguments).Count) {
                    $argument = @($node.Arguments)[0]
                    if ($argument -is [System.Management.Automation.Language.StringConstantExpressionAst]) { & $checkMember $node $argument $true }
                    elseif ($argument -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst] -and $argument -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                        & $flag $node $node.Extent.Text 'Methods must be called by name in read-only mode.'
                    }
                }
            }
            'MemberExpressionAst' {
                if ($node.Static -and $node.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Static members can be used only on a type name in read-only mode.'
                    break
                }
                & $checkMember $node $node.Member $false
            }
            'TypeExpressionAst' {
                if (-not (Test-AdminForgeReadOnlyType $node.TypeName)) { & $flag $node "[$($node.TypeName.FullName)]" 'Read-only scripts can use only basic .NET types (text, numbers, dates, collections, regex, Math).' }
            }
            'TypeConstraintAst' {
                if (-not (Test-AdminForgeReadOnlyType $node.TypeName)) { & $flag $node "[$($node.TypeName.FullName)]" 'Read-only scripts can use only basic .NET types (text, numbers, dates, collections, regex, Math).' }
            }
            'BinaryExpressionAst' {
                if ($node.Operator -eq 'As' -and $node.Right -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Conversions need a type name ([type]) in read-only mode.'
                }
            }
            'VariableExpressionAst' {
                $path = $node.VariablePath
                if ($path.IsDriveQualified) { & $flag $node $node.Extent.Text "Read-only scripts can't use provider variables (env:, function:, variable: …)."; break }
                $bareName = ($path.UserPath -split ':')[-1]
                if ($bareName -in $script:ReadOnlyDeniedVariables) { & $flag $node "`$$bareName" "Read-only scripts can't use the PowerShell engine, the host or module loading." }
            }
            'UsingStatementAst' { & $flag $node $node.Extent.Text 'Using statements are not allowed in read-only mode.' }
            'TypeDefinitionAst' { & $flag $node "class $($node.Name)" 'Classes and enums are not allowed in read-only mode.' }
            'ConfigurationDefinitionAst' { & $flag $node 'configuration' 'Configurations are not allowed in read-only mode.' }
            'DynamicKeywordStatementAst' { & $flag $node $node.Extent.Text 'Dynamic keywords are not allowed in read-only mode.' }
        }
    }
    $findings | Sort-Object -Property Line, Column
}

function Assert-AdminForgeReadOnlyScript {
    <#
    .SYNOPSIS
        Throws a 'readOnly' error for the first violation of the read-only policy (Test-AdminForgeReadOnlyScript).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Content)
    $finding = @(Test-AdminForgeReadOnlyScript -Content $Content) | Select-Object -First 1
    if ($finding) { throw (New-AdminForgeError -Category readOnly -Message $finding.Message -ErrorId 'AdminForge.ReadOnlyPolicy') }
}

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
    if ($existing -and ($existing.Options -band [System.Management.Automation.ScopedItemOptions]::Constant)) { return $false } # already guarded
    # Imported module functions and aliases live in the global scope; from here, the provider finds and removes those.
    if (Test-Path -LiteralPath "alias:$Name") { Remove-Item -LiteralPath "alias:$Name" -Force }
    if ($existing) { Remove-Item -LiteralPath "function:$Name" -Force }
    # Constant: a script cannot remove or redefine the guard.
    New-Item -Path 'function:' -Name "global:$Name" -Value $Body -Options Constant -Force | Out-Null
    $true
}

function Enable-AdminForgeReadOnlyMode {
    <#
    .SYNOPSIS
        Restricts the session to read operations while a read-mode script runs (the second layer; the worker
        checks the script with Test-AdminForgeReadOnlyScript first).
    .DESCRIPTION
        - Invoke-MgGraphRequest and Invoke-AzRestMethod (and their aliases) accept only -Method GET.
        - Every other command of every loaded module that is not PowerShell's own or AdminForge.Runner (Exchange
          Online and its generated tmpEXO_* module, Teams, PnP, Microsoft Graph, Az, …) whose verb is not Get, and
          every alias to such a command, is replaced by a constant function that throws
          "'<name>' is not allowed in read-only mode". -ModuleName limits this to the named modules (tests).
        - Unknown Verb-Noun commands with a non-Get verb (e.g. Exchange cmdlets that were not loaded) fail with the
          same message instead of "not recognized".
        - Module auto-loading is turned off (after importing PowerShell's utility, management and security
          modules), so a call cannot load a module whose commands are not guarded.
        Module-qualified names (PnP.PowerShell\New-PnPList) bypass shadowing; the static policy refuses them
        before the script runs.
    #>
    [CmdletBinding()]
    param(
        [string[]]$ModuleName,
        [switch]$SkipRestGuards,
        [switch]$KeepModuleAutoLoading
    )
    $script:Mode = 'read'
    $blocked = 0

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
            foreach ($name in @($entry.Name) + $entry.Aliases) { $null = Set-AdminForgeGlobalFunction -Name $name -Body $proxy }
        }
    }

    $commands = if ($ModuleName) {
        $modules = @(Get-Module -Name $ModuleName -ErrorAction SilentlyContinue)
        if ($modules.Count) { @(Get-Command -Module ($modules.Name | Select-Object -Unique) -ErrorAction SilentlyContinue) } else { @() }
    } else {
        @(Get-Command -ListImported -CommandType Alias, Function, Filter, Cmdlet -ErrorAction SilentlyContinue | Where-Object {
                $_.Module -and $_.Module.Name -ne 'AdminForge.Runner' -and -not (Test-AdminForgePowerShellModule $_.Module)
            })
    }
    foreach ($command in $commands) {
        $verb = ($command.Name -split '-', 2)[0]
        $target = if ($command.CommandType -eq 'Alias' -and $command.ResolvedCommandName) { ($command.ResolvedCommandName -split '-', 2)[0] } else { $verb }
        if ($verb -eq 'Get' -and $target -eq 'Get') { continue }
        if (Set-AdminForgeGlobalFunction -Name $command.Name -Body (New-AdminForgeReadOnlyBlock -CommandName $command.Name)) { $blocked++ }
    }

    $ExecutionContext.InvokeCommand.CommandNotFoundAction = {
        param([string]$CommandName, [System.Management.Automation.CommandLookupEventArgs]$EventArgs)
        $name = ($CommandName -split '\\')[-1]
        if ($name -match '^(?<verb>[A-Za-z]+)-[A-Za-z0-9]+$' -and $Matches['verb'] -ne 'Get') {
            $EventArgs.CommandScriptBlock = New-AdminForgeReadOnlyBlock -CommandName $name
            $EventArgs.StopSearch = $true
        }
    }

    if (-not $KeepModuleAutoLoading) {
        foreach ($name in 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security') {
            if (-not (Get-Module -Name $name)) { Import-Module -Name $name -Global -ErrorAction SilentlyContinue }
        }
        $global:PSModuleAutoLoadingPreference = 'None'
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
    'Connect-AdminForgeServices', 'Enable-AdminForgeReadOnlyMode', 'Get-AdminForgeMode',
    'Test-AdminForgeReadOnlyScript', 'Assert-AdminForgeReadOnlyScript'
)
