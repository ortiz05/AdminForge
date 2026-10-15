<#
.SYNOPSIS
    Runner self-test: echoes its inputs, reports progress, and needs no tokens.

.DESCRIPTION
    Used by the runner's end-to-end tests and as a smoke test after deployment. It exercises the event
    protocol (log, progress, output, error) and, on request, the read-only guard, a script failure, or a
    long-running job (for timeout and cancellation tests).

.PARAMETER Inputs
    message           string   Echoed back (default 'ping').
    steps             int      Number of progress steps, 1-20 (default 3).
    delayMs           int      Delay between steps in milliseconds, 0-5000 (default 0).
    sleepSeconds      int      Sleep this long before finishing, 0-3600 (default 0).
    fail              bool     Throw a script error after the progress steps.
    attemptWrite      bool     Call Set-Mailbox; in read mode this must fail with "not allowed in read-only mode".
    reportEnvironment bool     Include the names (never the values) of the worker's environment variables.

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    One output event: @{ echo; message; steps; mode; jobId; tenant; services; pwsh; environment? }.

.NOTES
    Tokens: none. Mode: read. Safe to run anywhere.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$message = Get-AdminForgeInput $Inputs 'message' -Default 'ping' -MaxLength 1000
$steps = Get-AdminForgeInput $Inputs 'steps' -Type Int -Default 3 -Minimum 1 -Maximum 20
$delayMs = Get-AdminForgeInput $Inputs 'delayMs' -Type Int -Default 0 -Minimum 0 -Maximum 5000
$sleepSeconds = Get-AdminForgeInput $Inputs 'sleepSeconds' -Type Int -Default 0 -Minimum 0 -Maximum 3600
$fail = Get-AdminForgeInput $Inputs 'fail' -Type Bool -Default $false
$attemptWrite = Get-AdminForgeInput $Inputs 'attemptWrite' -Type Bool -Default $false
$reportEnvironment = Get-AdminForgeInput $Inputs 'reportEnvironment' -Type Bool -Default $false

Write-AdminForgeLog "Test-Runner started in $($Context['Mode']) mode"
for ($i = 1; $i -le $steps; $i++) {
    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
    Write-AdminForgeProgress -Percent ([Math]::Floor(100 * $i / $steps)) -Message "Step $i of $steps"
}

if ($sleepSeconds -gt 0) {
    Write-AdminForgeLog "Sleeping $sleepSeconds s"
    Start-Sleep -Seconds $sleepSeconds
}

if ($attemptWrite) {
    Write-AdminForgeLog -Level Warn 'Attempting a write command (Set-Mailbox)'
    Set-Mailbox -Identity 'adminforge-diagnostics' -HiddenFromAddressListsEnabled $true
}

if ($fail) {
    throw 'Test-Runner was asked to fail'
}

$result = [ordered]@{
    echo     = $Inputs
    message  = $message
    steps    = $steps
    mode     = $Context['Mode']
    jobId    = $Context['JobId']
    tenant   = $Context['Tenant']
    services = @($Context['Services'])
    pwsh     = $PSVersionTable.PSVersion.ToString()
}
if ($reportEnvironment) {
    $result.environment = @(Get-ChildItem env: | ForEach-Object Name | Sort-Object)
}
Write-AdminForgeOutput -Data $result
Write-AdminForgeLog 'Test-Runner finished'
