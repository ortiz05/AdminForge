<#
.SYNOPSIS
    One mailbox's settings that leaver and incident playbooks check first: type, forwarding, address-list
    visibility, holds and the automatic-reply state.

.DESCRIPTION
    Reads the mailbox with Get-EXOMailbox and (optionally) its automatic-reply configuration with
    Get-MailboxAutoReplyConfiguration. Mailbox forwarding to a recipient object (ForwardingAddress, often a mail
    contact) is resolved to its address with Get-EXORecipient. A forwarding target is "external" when its domain is
    not one of the tenant's accepted domains. Auto-reply message text is not returned.

.PARAMETER Inputs
    identity           string  Required. Primary SMTP address or UPN of the mailbox.
    includeAutoReply   bool    Also read the automatic-reply state (default true).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ displayName; primarySmtpAddress; userPrincipalName; recipientTypeDetails; isDirSynced;
       hiddenFromAddressListsEnabled; litigationHoldEnabled; archiveStatus;
       forwarding = @{ enabled; forwardingSmtpAddress; forwardingAddress; forwardingAddressTarget;
                       deliverToMailboxAndForward; targets; external };
       autoReply = @{ state; externalAudience; startTime; endTime } | $null }

.NOTES
    Tokens: exchange. Mode: read. Exchange role: View-Only Recipients (or higher).
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320
$includeAutoReply = Get-AdminForgeInput $Inputs 'includeAutoReply' -Type Bool -Default $true

Write-AdminForgeProgress -Percent 10 -Message 'Reading mailbox'
$properties = 'RecipientTypeDetails', 'IsDirSynced', 'HiddenFromAddressListsEnabled', 'LitigationHoldEnabled', 'ArchiveStatus',
'ForwardingSmtpAddress', 'ForwardingAddress', 'DeliverToMailboxAndForward'
try {
    $m = Get-EXOMailbox -Identity $identity -Properties $properties |
        Select-Object DisplayName, PrimarySmtpAddress, UserPrincipalName, RecipientTypeDetails, IsDirSynced, HiddenFromAddressListsEnabled,
        LitigationHoldEnabled, ArchiveStatus, ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = [string]$m.PrimarySmtpAddress

$smtpForward = if ($m.ForwardingSmtpAddress) { ([string]$m.ForwardingSmtpAddress) -replace '^smtp:', '' } else { $null }
$recipientForward = if ($m.ForwardingAddress) { [string]$m.ForwardingAddress } else { $null }
$recipientTarget = $null
if ($recipientForward) {
    try {
        $r = Get-EXORecipient -Identity $recipientForward -Properties ExternalEmailAddress | Select-Object PrimarySmtpAddress, ExternalEmailAddress
        $recipientTarget = if ($r.ExternalEmailAddress) { ([string]$r.ExternalEmailAddress) -replace '^smtp:', '' } else { [string]$r.PrimarySmtpAddress }
    } catch {
        Write-AdminForgeLog -Level Warn "Could not resolve the forwarding recipient of ${address}: $($_.Exception.Message)"
    }
}
$targets = @(@($smtpForward, $recipientTarget) | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)

$external = $null
if ($targets.Count) {
    Write-AdminForgeProgress -Percent 40 -Message 'Reading accepted domains'
    $accepted = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() })
    $external = $false
    foreach ($t in $targets) {
        $domain = ($t -split '@')[-1]
        $internal = @($accepted | Where-Object { $domain -eq $_ -or $domain.EndsWith(".$_") }).Count -gt 0
        if (-not $internal) { $external = $true }
    }
}

$autoReply = $null
if ($includeAutoReply) {
    Write-AdminForgeProgress -Percent 70 -Message 'Reading automatic replies'
    $a = Get-MailboxAutoReplyConfiguration -Identity $address | Select-Object AutoReplyState, ExternalAudience, StartTime, EndTime
    $autoReply = [ordered]@{
        state            = [string]$a.AutoReplyState
        externalAudience = [string]$a.ExternalAudience
        startTime        = if ($a.StartTime) { ([datetime]$a.StartTime).ToUniversalTime().ToString('o') } else { $null }
        endTime          = if ($a.EndTime) { ([datetime]$a.EndTime).ToUniversalTime().ToString('o') } else { $null }
    }
}

$result = [ordered]@{
    displayName                   = [string]$m.DisplayName
    primarySmtpAddress            = $address
    userPrincipalName             = [string]$m.UserPrincipalName
    recipientTypeDetails          = [string]$m.RecipientTypeDetails
    isDirSynced                   = [bool]$m.IsDirSynced
    hiddenFromAddressListsEnabled = [bool]$m.HiddenFromAddressListsEnabled
    litigationHoldEnabled         = [bool]$m.LitigationHoldEnabled
    archiveStatus                 = [string]$m.ArchiveStatus
    forwarding                    = [ordered]@{
        enabled                    = $targets.Count -gt 0 -or [bool]$recipientForward
        forwardingSmtpAddress      = $smtpForward
        forwardingAddress          = $recipientForward
        forwardingAddressTarget    = $recipientTarget
        deliverToMailboxAndForward = [bool]$m.DeliverToMailboxAndForward
        targets                    = $targets
        external                   = $external
    }
    autoReply                     = $autoReply
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
