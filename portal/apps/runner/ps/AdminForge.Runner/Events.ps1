<#
    AdminForge.Runner — events. Dot-sourced by AdminForge.Runner.psm1 into the module's scope (which sets strict mode);
    not loaded on its own.

    Everything a job reports reaches the supervisor as one NDJSON event per line on the worker's protocol channel
    (stdout), or a script block in tests (Set-AdminForgeEventSink -ScriptBlock):
      {type:'log', level, message, ts} {type:'progress', percent, message} {type:'output', data}
    (Error events — {type:'error', message, category} — are written by worker.ps1.)

    Script API: Write-AdminForgeLog, Write-AdminForgeProgress, Write-AdminForgeOutput.
    Worker:     Set-AdminForgeEventSink, Send-AdminForgeEvent, Send-AdminForgeStreamRecord.
    Log text goes through Format-AdminForgeMessage (Errors.ps1).
#>

# Where events go: a TextWriter (the worker's protocol channel), a script block (tests), or neither (stdout).
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
    Send-AdminForgeEvent @{ type = 'log'; level = $Level.ToLowerInvariant(); message = (Format-AdminForgeMessage $Message); ts = [DateTime]::UtcNow.ToString('o') }
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
