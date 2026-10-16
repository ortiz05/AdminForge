#Requires -Version 7.4
<#
    AdminForge.Runner — helpers for AdminForge runner scripts and the runner worker.

    Scripts use:   Write-AdminForgeLog, Write-AdminForgeProgress, Write-AdminForgeOutput,
                   Get-AdminForgeInput, New-AdminForgeError, Get-AdminForgeMode
    The worker uses: Set-AdminForgeEventSink, Send-AdminForgeEvent, Connect-AdminForgeServices,
                   Test-AdminForgeReadOnlyScript, Enable-AdminForgeReadOnlyMode, Send-AdminForgeStreamRecord,
                   Get-AdminForgeErrorCategory

    Events are NDJSON objects (one per line) on the worker's protocol channel (stdout):
      {type:'log', level, message, ts} {type:'progress', percent, message} {type:'output', data}
      {type:'error', message, category}

    One file per concern, dot-sourced below into this module's scope (they share its script: variables and strict
    mode; none of them is loaded on its own):
      Events.ps1          the event sink and the log / progress / output events
      Errors.ps1          error records with an AdminForge category; readable service error text
      Inputs.ps1          Get-AdminForgeInput: typed, bounded job inputs
      Connections.ps1     Connect-AdminForgeServices with the engineer's forwarded delegated tokens
      ReadOnlyPolicy.ps1  read mode: the static script policy and the runtime write guards (a security boundary)
    The worker imports this module for every job (worker.ps1), so a saved edit applies to the next job of a runner that
    uses this checkout: run the Pester suite first (tests/runner/pester/run.ps1). The Export-ModuleMember list below
    and FunctionsToExport in AdminForge.Runner.psd1 must stay the same (a Pester test checks).
#>
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'Events.ps1')
. (Join-Path $PSScriptRoot 'Errors.ps1')
. (Join-Path $PSScriptRoot 'Inputs.ps1')
. (Join-Path $PSScriptRoot 'Connections.ps1')
. (Join-Path $PSScriptRoot 'ReadOnlyPolicy.ps1')

Export-ModuleMember -Function @(
    'Set-AdminForgeEventSink', 'Send-AdminForgeEvent', 'Send-AdminForgeStreamRecord',
    'Write-AdminForgeLog', 'Write-AdminForgeProgress', 'Write-AdminForgeOutput',
    'New-AdminForgeError', 'Get-AdminForgeErrorCategory', 'Format-AdminForgeMessage', 'Get-AdminForgeInput',
    'Connect-AdminForgeServices', 'Enable-AdminForgeReadOnlyMode', 'Get-AdminForgeMode',
    'Test-AdminForgeReadOnlyScript', 'Assert-AdminForgeReadOnlyScript'
)
