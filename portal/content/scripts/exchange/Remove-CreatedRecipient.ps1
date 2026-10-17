<#
.SYNOPSIS
    Removes a shared mailbox, room mailbox or distribution list that AdminForge created.

.DESCRIPTION
    Only recipients AdminForge created can be removed this way: CustomAttribute15 must start with
    "AdminForge-created" (set by the create playbooks), the type must be the one asked for, and the Entra object id
    the playbook read must equal the recipient's ExternalDirectoryObjectId — otherwise nothing changes; the recipient
    is then removed by its Exchange id, not by address. The mark is a guard rail against mistakes, not a security
    boundary: any Exchange administrator (or, for synced objects, on-premises extensionAttribute15) can set it. A
    recipient Exchange says no longer exists is reported as already removed (idempotent retries); any other lookup
    failure stops the job. Exchange only lets a list's owners remove it, so for a distribution list the engineer must
    be one of its owners — checked first — unless bypassSecurityGroupManagerCheck is set (needs Organization
    Management). Mailboxes go to Exchange's soft-deleted state (restorable for 30 days); lists are removed for good.

.PARAMETER Inputs
    identity                          string  Required. Primary SMTP address.
    objectId                          string  Required. Entra object id (ExternalDirectoryObjectId).
    kind                              string  Required. sharedMailbox | roomMailbox | distributionList.
    bypassSecurityGroupManagerCheck   bool    Distribution lists the engineer doesn't own (default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ identity; kind; removed; note }

.NOTES
    Tokens: exchange. Mode: write. Exchange role: Mail Recipient Creation (mailboxes) or Distribution Groups (lists);
    Security Group Creation and Membership (Organization Management) to remove a list you don't own.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Context['Mode'] -ne 'write') {
    throw (New-AdminForgeError -Category readOnly -Message 'Removing a recipient changes data; run this script in write mode (armed session).')
}
$identity = (Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@*]+@[^\s@*]+\.[^\s@*]+$' -MaxLength 320).ToLowerInvariant()
$objectId = Get-AdminForgeInput $Inputs 'objectId' -Required -Pattern '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$kind = Get-AdminForgeInput $Inputs 'kind' -Required -AllowedValues 'sharedMailbox', 'roomMailbox', 'distributionList'
$bypass = Get-AdminForgeInput $Inputs 'bypassSecurityGroupManagerCheck' -Type Bool -Default $false
$types = @{ sharedMailbox = 'SharedMailbox'; roomMailbox = 'RoomMailbox'; distributionList = 'MailUniversalDistributionGroup' }
$labels = @{
    UserMailbox = 'a user mailbox'; SharedMailbox = 'a shared mailbox'; RoomMailbox = 'a room mailbox'
    EquipmentMailbox = 'an equipment mailbox'; MailUniversalDistributionGroup = 'a distribution list'
    MailUniversalSecurityGroup = 'a mail-enabled security group'; GroupMailbox = 'a Microsoft 365 group'
    MailUser = 'a mail user'; GuestMailUser = 'a guest'; MailContact = 'a mail contact'
}
function Get-Label([string]$Type) { if ($labels.ContainsKey($Type)) { $labels[$Type] } else { 'another recipient' } }
$callerOid = if ($Context['User'] -is [System.Collections.IDictionary] -and $Context['User']['ObjectId']) { ([string]$Context['User']['ObjectId']).ToLowerInvariant() } else { '' }

Write-AdminForgeProgress -Percent 10 -Message 'Reading the recipient'
try {
    $r = Get-EXORecipient -Identity $identity -Properties CustomAttribute15, ManagedBy |
        Select-Object PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId, CustomAttribute15, ManagedBy, Guid
} catch {
    if ("$($_.Exception.Message) $($_.FullyQualifiedErrorId)" -match "couldn't find object|couldn't be found|ManagementObjectNotFound") {
        Write-AdminForgeOutput -Data ([ordered]@{ identity = $identity; kind = $kind; removed = $false; note = 'It no longer exists; nothing to remove.' })
        return
    }
    Write-AdminForgeLog -Level Warn "Looking up $identity failed: $($_.Exception.Message)"
    throw (New-AdminForgeError -Category script -Message "Exchange couldn't read $identity just now, so nothing was removed. Try again in a few minutes.")
}
if ([string]$r.ExternalDirectoryObjectId -ine $objectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $identity doesn't match the recipient, so nothing was removed. Start the playbook again.")
}
if (-not ([string]$r.CustomAttribute15).StartsWith('AdminForge-created')) {
    throw (New-AdminForgeError -Category input -Message "$identity wasn't created by AdminForge, so it can't be removed here. Remove it in the Exchange admin center.")
}
if ([string]$r.RecipientTypeDetails -ne $types[$kind]) {
    throw (New-AdminForgeError -Category input -Message "$identity is $(Get-Label ([string]$r.RecipientTypeDetails)), not $(Get-Label $types[$kind]); nothing was removed. Pick what it is and try again.")
}
if ($kind -eq 'distributionList' -and -not $bypass) {
    $ownerIds = @($r.ManagedBy | Where-Object { $_ } | ForEach-Object {
            try { ([string](Get-EXORecipient -Identity ([string]$_) | Select-Object -ExpandProperty ExternalDirectoryObjectId)).ToLowerInvariant() } catch { $null }
        } | Where-Object { $_ })
    if (-not $callerOid -or $ownerIds -notcontains $callerOid) {
        throw (New-AdminForgeError -Category input -Message "You're not an owner of $identity, and Exchange only lets a list's owners remove it, so nothing was removed. Ask one of its owners, or — if you hold Organization Management — choose that you're not an owner.")
    }
}

# Removed by the Exchange id of the recipient checked above, not by address.
$target = if ([string]$r.Guid) { [string]$r.Guid } else { [string]$r.ExternalDirectoryObjectId }
Write-AdminForgeProgress -Percent 50 -Message 'Removing'
Write-AdminForgeLog "Removing $kind $identity"
if ($kind -eq 'distributionList') {
    $common = @{ Identity = $target; Confirm = $false }
    if ($bypass) { $common.BypassSecurityGroupManagerCheck = $true }
    Remove-DistributionGroup @common
    $note = 'The distribution list was removed.'
} else {
    Remove-Mailbox -Identity $target -Confirm:$false
    $note = 'The mailbox was removed. Exchange keeps it for 30 days, during which an Exchange administrator can restore it.'
}
Write-AdminForgeOutput -Data ([ordered]@{ identity = $identity; kind = $kind; removed = $true; note = $note })
Write-AdminForgeProgress -Percent 100 -Message 'Done'
