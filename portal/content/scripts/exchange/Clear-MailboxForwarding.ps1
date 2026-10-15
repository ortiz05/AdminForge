<#
.SYNOPSIS
    Removes mailbox-level forwarding (ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward).

.DESCRIPTION
    Reads the mailbox's forwarding settings, clears them with one Set-Mailbox call and reads them back. A mailbox that
    doesn't forward is reported as unchanged (idempotent). The previous values are returned so they are kept in the
    run record. Inbox rules that forward mail are not touched (see Get-InboxRules.ps1).

.PARAMETER Inputs
    identity   string  Required. Primary SMTP address or UPN of the mailbox.

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ identity; displayName; primarySmtpAddress; before = @{ forwardingSmtpAddress; forwardingAddress;
       deliverToMailboxAndForward }; after = @{ … }; changed; verified }

.NOTES
    Tokens: exchange. Mode: write. Exchange role: Mail Recipients (Recipient Management) or higher.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Context['Mode'] -ne 'write') {
    throw (New-AdminForgeError -Category readOnly -Message 'Removing forwarding changes data; run this script in write mode (armed session).')
}
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320

function Read-Forwarding([string]$Id) {
    $m = Get-EXOMailbox -Identity $Id -Properties ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward |
        Select-Object DisplayName, PrimarySmtpAddress, ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward
    [ordered]@{
        displayName                = [string]$m.DisplayName
        primarySmtpAddress         = [string]$m.PrimarySmtpAddress
        forwardingSmtpAddress      = if ($m.ForwardingSmtpAddress) { ([string]$m.ForwardingSmtpAddress) -replace '^smtp:', '' } else { $null }
        forwardingAddress          = if ($m.ForwardingAddress) { [string]$m.ForwardingAddress } else { $null }
        deliverToMailboxAndForward = [bool]$m.DeliverToMailboxAndForward
    }
}
$forwards = { param($f) [bool]($f.forwardingSmtpAddress -or $f.forwardingAddress -or $f.deliverToMailboxAndForward) }

Write-AdminForgeProgress -Percent 10 -Message 'Reading forwarding'
try {
    $before = Read-Forwarding $identity
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = $before.primarySmtpAddress
$state = { param($f) [ordered]@{ forwardingSmtpAddress = $f.forwardingSmtpAddress; forwardingAddress = $f.forwardingAddress; deliverToMailboxAndForward = $f.deliverToMailboxAndForward } }
$result = [ordered]@{
    identity           = $identity
    displayName        = $before.displayName
    primarySmtpAddress = $address
    before             = & $state $before
    after              = & $state $before
    changed            = $false
    verified           = $false
}

if (-not (& $forwards $before)) {
    Write-AdminForgeLog "$address doesn't forward mail; nothing to do"
    $result.verified = $true
    Write-AdminForgeProgress -Percent 100 -Message 'Nothing to clear'
    Write-AdminForgeOutput -Data $result
    return
}

Write-AdminForgeProgress -Percent 40 -Message 'Removing forwarding'
Write-AdminForgeLog "Removing forwarding from $address (was: $(@($before.forwardingSmtpAddress, $before.forwardingAddress) | Where-Object { $_ } | Join-String -Separator ', '))"
Set-Mailbox -Identity $address -ForwardingSmtpAddress $null -ForwardingAddress $null -DeliverToMailboxAndForward $false
$result.changed = $true

for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-AdminForgeProgress -Percent (50 + 15 * $attempt) -Message "Verifying ($attempt)"
    $after = Read-Forwarding $address
    $result.after = & $state $after
    if (-not (& $forwards $after)) { $result.verified = $true; break }
    Start-Sleep -Seconds 3
}
if (-not $result.verified) { Write-AdminForgeLog -Level Warn "The change was submitted but $address still reports forwarding" }

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
