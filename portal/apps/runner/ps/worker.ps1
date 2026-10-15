<#
.SYNOPSIS
    AdminForge runner worker: imports modules, waits for exactly one job on stdin, runs it, exits.

.DESCRIPTION
    Started by the runner supervisor (pre-forked) as:
        pwsh -NoLogo -NoProfile -NonInteractive -File worker.ps1
    Protocol (one JSON object per line):
      stdout  {"type":"ready",...} once modules are imported, then the job's events
              (log / progress / output / error) and finally {"type":"exit","status":"succeeded"|"failed"}.
      stdin   exactly one line: the job, including the engineer's delegated tokens. Tokens arrive only here:
              never in arguments, environment variables, files, or log lines.
    Anything else that writes to the console (Write-Host outside the script, modules printing banners) is
    diverted to stderr so stdout carries only protocol lines.

    Environment (set by the supervisor):
      ADMINFORGE_RUNNER_MODULES_DIR  pinned modules (put first on PSModulePath)
      ADMINFORGE_RUNNER_PRELOAD      Graph,Exchange,Teams,SharePoint,Az | none
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'Continue'
$PSStyle.OutputRendering = 'PlainText'

# --- Protocol channel: the real stdout. Everything else that writes to Console.Out goes to stderr. ---
$utf8 = [System.Text.UTF8Encoding]::new($false)
$script:Protocol = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$script:Protocol.AutoFlush = $true
$script:Protocol.NewLine = "`n"
[Console]::SetOut([Console]::Error)
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)

function Send-WorkerLine([System.Collections.IDictionary]$Event) {
    $script:Protocol.WriteLine((ConvertTo-Json -InputObject $Event -Depth 32 -Compress -EnumsAsStrings -WarningAction SilentlyContinue))
}

function Exit-Worker([string]$Status) {
    Send-WorkerLine @{ type = 'exit'; status = $Status }
    $script:Protocol.Flush()
    exit $(if ($Status -eq 'succeeded') { 0 } else { 1 })
}

function Send-WorkerError([string]$Message, [string]$Category) {
    Send-WorkerLine @{ type = 'error'; message = $Message; category = $Category }
}

try {
    # --- Pinned modules first; drop the user's and machine-wide module paths. ---
    $paths = [System.Collections.Generic.List[string]]::new()
    if ($env:ADMINFORGE_RUNNER_MODULES_DIR) { $paths.Add($env:ADMINFORGE_RUNNER_MODULES_DIR) }
    $paths.Add((Join-Path $PSHOME 'Modules'))
    $env:PSModulePath = $paths -join [System.IO.Path]::PathSeparator

    Import-Module (Join-Path $PSScriptRoot 'AdminForge.Runner/AdminForge.Runner.psd1') -Force
    Set-AdminForgeEventSink -Writer $script:Protocol

    # Import order matters: PnP.PowerShell must load before MicrosoftTeams, otherwise PnP's assembly
    # resolver recurses until the process dies (stack overflow) on Connect-PnPOnline.
    $moduleFor = [ordered]@{
        SharePoint = 'PnP.PowerShell'
        Graph      = 'Microsoft.Graph.Authentication'
        Exchange   = 'ExchangeOnlineManagement'
        Teams      = 'MicrosoftTeams'
        Az         = 'Az.Accounts'
    }
    $requested = if ([string]::IsNullOrWhiteSpace($env:ADMINFORGE_RUNNER_PRELOAD)) { @($moduleFor.Keys) }
    elseif ($env:ADMINFORGE_RUNNER_PRELOAD.Trim() -eq 'none') { @() }
    else { @($env:ADMINFORGE_RUNNER_PRELOAD.Split(',').Trim()) }
    if ($requested -contains 'Teams' -and $requested -notcontains 'SharePoint') { $requested += 'SharePoint' }
    $preload = @($moduleFor.Keys | Where-Object { $requested -contains $_ })

    $loaded = [System.Collections.Generic.List[object]]::new()
    $failed = [System.Collections.Generic.List[object]]::new()
    foreach ($service in $preload) {
        $name = $moduleFor[$service]
        try {
            Import-Module -Name $name -ErrorAction Stop -WarningAction SilentlyContinue
            $module = Get-Module -Name $name | Select-Object -First 1
            $loaded.Add(@{ name = $module.Name; version = $module.Version.ToString() })
        } catch {
            $failed.Add(@{ name = $name; error = $_.Exception.Message })
        }
    }
    Send-WorkerLine @{
        type    = 'ready'
        pid     = $PID
        pwsh    = $PSVersionTable.PSVersion.ToString()
        modules = $loaded.ToArray()
        failed  = $failed.ToArray()
    }
} catch {
    [Console]::Error.WriteLine("worker startup failed: $($_.Exception.Message)")
    exit 2
}

# --- Exactly one job. EOF without a job means the supervisor is shutting down. ---
$line = $stdin.ReadLine()
if ([string]::IsNullOrWhiteSpace($line)) { exit 0 }

$job = $null
try {
    $job = ConvertFrom-Json -InputObject $line -AsHashtable -Depth 64
} catch {
    $job = $null
}
$line = $null
if ($job -isnot [System.Collections.IDictionary] -or $job['script'] -isnot [System.Collections.IDictionary] -or $job['tenant'] -isnot [System.Collections.IDictionary]) {
    Send-WorkerError 'The job payload is not a valid job object' 'protocol'
    Exit-Worker 'failed'
}

$mode = if ($job['mode'] -eq 'write') { 'write' } else { 'read' }
$scriptPath = [string]$job['script']['path']
$tenant = $job['tenant']
$inputs = if ($job['inputs'] -is [System.Collections.IDictionary]) { $job['inputs'] } else { @{} }
$tokens = if ($job['tokens'] -is [System.Collections.IDictionary]) { $job['tokens'] } else { @{} }

# Services follow the tokens the API forwarded (it forwards only what the script declares).
$services = [System.Collections.Generic.List[string]]::new()
if ($tokens['graph']) { $services.Add('Graph') }
if ($tokens['exchange']) { $services.Add('Exchange') }
if ($tokens['teams']) { $services.Add('Teams') }
if ($tokens['sharepointAdmin']) { $services.Add('SharePoint') }
if ($tokens['arm']) { $services.Add('Az') }

$connection = @{ Services = @(); User = @{ Upn = $null; ObjectId = $null } }
try {
    if ($services.Count) {
        $connection = Connect-AdminForgeServices -Context @{ Mode = $mode; Tenant = $tenant; Tokens = $tokens } -Services $services.ToArray()
        Write-AdminForgeLog -Level Debug "Connected: $($connection.Services -join ', ')"
    }
    if ($mode -eq 'read') { $null = Enable-AdminForgeReadOnlyMode }
} catch {
    Send-WorkerError $_.Exception.Message (Get-AdminForgeErrorCategory $_)
    Exit-Worker 'failed'
} finally {
    # The script never sees the tokens, the raw job, or errors whose invocation info could hold them.
    $tokens.Clear()
    $job['tokens'] = $null
    $Error.Clear()
}

$context = @{
    JobId    = [string]$job['jobId']
    Mode     = $mode
    Tenant   = @{
        Id            = [string]$tenant['id']
        Domain        = [string]$tenant['domain']
        SpoTenantName = if ($tenant.Contains('spoTenantName')) { [string]$tenant['spoTenantName'] } else { $null }
    }
    Services = @($connection.Services)
    User     = $connection.User
}
try {
    # The supervisor verified this text against the pinned sha256; running the text (not the file) means
    # the bytes that run are exactly the bytes that were hashed.
    $scriptBlock = [scriptblock]::Create([string]$job['script']['content'])
} catch {
    Send-WorkerError "The script does not parse: $($_.Exception.Message)" 'script'
    Exit-Worker 'failed'
}
Remove-Variable -Name job, tokens, tenant -ErrorAction SilentlyContinue

try {
    & $scriptBlock -Inputs $inputs -Context $context *>&1 | Send-AdminForgeStreamRecord
} catch {
    $err = $_
    # The job script has no file; its frames read "<No file>: line N" (module frames carry file paths).
    $where = if ([string]$err.ScriptStackTrace -match '<No file>: line (\d+)') { " (line $($Matches[1]))" } else { '' }
    Send-WorkerError "$($err.Exception.Message)$where" (Get-AdminForgeErrorCategory $err)
    Exit-Worker 'failed'
}
Exit-Worker 'succeeded'
