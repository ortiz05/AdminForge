<#
.SYNOPSIS
    Hides a mailbox from the address lists (GAL) or shows it again.

.DESCRIPTION
    Reads HiddenFromAddressListsEnabled, sets it with Set-Mailbox when it differs, and reads it back. A mailbox that
    is already in the requested state is reported as unchanged (idempotent). For mailboxes whose account is synced
    from on-premises Active Directory, Exchange Online may refuse the change: set msExchHideFromAddressLists in AD.

.PARAMETER Inputs
    identity   string  Required. Primary SMTP address or UPN of the mailbox.
    hidden     bool    Required. true = hide from address lists; false = show.

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ identity; displayName; primarySmtpAddress; isDirSynced; before; after; changed; verified }

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
    throw (New-AdminForgeError -Category readOnly -Message 'Changing address-list visibility changes data; run this script in write mode (armed session).')
}
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320
$hidden = Get-AdminForgeInput $Inputs 'hidden' -Type Bool -Required

$read = {
    param([string]$Id)
    Get-EXOMailbox -Identity $Id -Properties HiddenFromAddressListsEnabled, IsDirSynced |
        Select-Object DisplayName, PrimarySmtpAddress, HiddenFromAddressListsEnabled, IsDirSynced
}
Write-AdminForgeProgress -Percent 10 -Message 'Reading mailbox'
try {
    $mailbox = & $read $identity
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = [string]$mailbox.PrimarySmtpAddress
$before = [bool]$mailbox.HiddenFromAddressListsEnabled
$result = [ordered]@{
    identity           = $identity
    displayName        = [string]$mailbox.DisplayName
    primarySmtpAddress = $address
    isDirSynced        = [bool]$mailbox.IsDirSynced
    before             = $before
    after              = $before
    changed            = $false
    verified           = $false
}
if ($before -eq $hidden) {
    Write-AdminForgeLog "$address is already $(if ($hidden) { 'hidden from' } else { 'shown in' }) the address lists"
    $result.verified = $true
    Write-AdminForgeProgress -Percent 100 -Message 'Nothing to change'
    Write-AdminForgeOutput -Data $result
    return
}

Write-AdminForgeProgress -Percent 40 -Message $(if ($hidden) { 'Hiding from address lists' } else { 'Showing in address lists' })
Set-Mailbox -Identity $address -HiddenFromAddressListsEnabled $hidden
$result.changed = $true
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $result.after = [bool](& $read $address).HiddenFromAddressListsEnabled
    if ($result.after -eq $hidden) { $result.verified = $true; break }
    Start-Sleep -Seconds 3
}
if (-not $result.verified) { Write-AdminForgeLog -Level Warn "The change was submitted but $address doesn't show it yet" }
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
