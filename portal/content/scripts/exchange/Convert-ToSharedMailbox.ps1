<#
.SYNOPSIS
    Converts a user mailbox to a shared mailbox.

.DESCRIPTION
    Verifies the mailbox exists and is a UserMailbox, converts it with Set-Mailbox -Type Shared, then reads
    it back to confirm. A mailbox that is already shared is reported as unchanged (idempotent).
    The licence is not removed: a shared mailbox up to 50 GB without an archive or hold needs none, so the
    playbook should remove it in a separate, reviewed step.

.PARAMETER Inputs
    identity   string  Required. Primary SMTP address or UPN of the mailbox.

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ identity; displayName; primarySmtpAddress; before; after; changed; verified; note }

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
    throw (New-AdminForgeError -Category readOnly -Message 'Converting a mailbox changes data; run this script in write mode (armed session).')
}
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320

Write-AdminForgeProgress -Percent 10 -Message 'Reading mailbox'
try {
    $mailbox = Get-EXOMailbox -Identity $identity -Properties RecipientTypeDetails | Select-Object DisplayName, PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$before = [string]$mailbox.RecipientTypeDetails
$result = [ordered]@{
    identity           = $identity
    displayName        = [string]$mailbox.DisplayName
    primarySmtpAddress = [string]$mailbox.PrimarySmtpAddress
    before             = $before
    after              = $before
    changed            = $false
    verified           = $false
    note               = 'The licence was not removed. Shared mailboxes up to 50 GB without an archive or litigation hold do not need one.'
}

if ($before -eq 'SharedMailbox') {
    Write-AdminForgeLog "$identity is already a shared mailbox; nothing to do"
    $result.verified = $true
    Write-AdminForgeProgress -Percent 100 -Message 'Already shared'
    Write-AdminForgeOutput -Data $result
    return
}
if ($before -ne 'UserMailbox') {
    throw (New-AdminForgeError -Category input -Message "Only user mailboxes can be converted; '$identity' is a $before.")
}

Write-AdminForgeProgress -Percent 40 -Message 'Converting to shared'
Write-AdminForgeLog "Converting $identity ($($result.displayName)) from UserMailbox to SharedMailbox"
Set-Mailbox -Identity ([string]$mailbox.PrimarySmtpAddress) -Type Shared
$result.changed = $true

# The change can take a moment to show up; read it back a few times.
for ($attempt = 1; $attempt -le 6; $attempt++) {
    Write-AdminForgeProgress -Percent (50 + 8 * $attempt) -Message "Verifying ($attempt)"
    $after = [string](Get-EXOMailbox -Identity ([string]$mailbox.PrimarySmtpAddress) -Properties RecipientTypeDetails | Select-Object -ExpandProperty RecipientTypeDetails)
    $result.after = $after
    if ($after -eq 'SharedMailbox') { $result.verified = $true; break }
    Start-Sleep -Seconds 5
}
if (-not $result.verified) { Write-AdminForgeLog -Level Warn "The conversion was submitted but $identity still reports $($result.after)" }

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
