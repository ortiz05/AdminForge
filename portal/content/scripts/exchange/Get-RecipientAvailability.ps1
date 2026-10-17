<#
.SYNOPSIS
    Reports whether email addresses and aliases are free in Exchange Online, and which domains it accepts.

.DESCRIPTION
    For each address and alias, looks the value up as a recipient identity (Get-EXORecipient -Identity — never a
    filter built from input). Only "couldn't find object" counts as free; a value more than one recipient answers to is
    refused, and any other failure (throttling, permissions, a service error) fails the job instead of reporting the
    value free. A used value reports the recipient's type (and a readable label), its Entra object id, whether
    AdminForge created it (CustomAttribute15 starts with "AdminForge-created") and, for a group, the Entra object ids
    of its owners — so a create playbook run again can continue where it stopped, and the removal playbook can refuse
    recipients AdminForge didn't create or lists the engineer doesn't own. Also returns the accepted domains.

.PARAMETER Inputs
    addresses   string[]  SMTP addresses to check (up to 20).
    aliases     string[]  Aliases (mail nicknames) to check (up to 20).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ acceptedDomains = @(<domain>); items = @(@{ value; kind = 'address'|'alias'; taken; recipientTypeDetails;
       typeLabel; displayName; primarySmtpAddress; externalDirectoryObjectId; createdByAdminForge;
       ownerObjectIds }) }

.NOTES
    Tokens: exchange. Mode: read. Exchange role: View-Only Recipients or higher.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$addresses = Get-AdminForgeInput $Inputs 'addresses' -Type StringArray -Pattern '^[^\s@*]+@[^\s@*]+\.[^\s@*]+$' -MaxLength 320 -MaxCount 20
$aliases = Get-AdminForgeInput $Inputs 'aliases' -Type StringArray -Pattern '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$' -MaxLength 64 -MaxCount 20
if ($addresses.Count -eq 0 -and $aliases.Count -eq 0) {
    throw (New-AdminForgeError -Category input -Message "Provide at least one value in 'addresses' or 'aliases'.")
}

$labels = @{
    UserMailbox = 'a user mailbox'; SharedMailbox = 'a shared mailbox'; RoomMailbox = 'a room mailbox'
    EquipmentMailbox = 'an equipment mailbox'; SchedulingMailbox = 'a scheduling mailbox'
    MailUniversalDistributionGroup = 'a distribution list'; MailUniversalSecurityGroup = 'a mail-enabled security group'
    GroupMailbox = 'a Microsoft 365 group'; MailUser = 'a mail user'; GuestMailUser = 'a guest'; MailContact = 'a mail contact'
    DynamicDistributionGroup = 'a dynamic distribution list'
}

Write-AdminForgeProgress -Percent 10 -Message 'Reading accepted domains'
$domains = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() } | Where-Object { $_ } | Sort-Object -Unique)

function Find-Recipient([string]$Value, [string]$Kind) {
    $item = [ordered]@{
        value                     = $Value
        kind                      = $Kind
        taken                     = $false
        recipientTypeDetails      = $null
        typeLabel                 = $null
        displayName               = $null
        primarySmtpAddress        = $null
        externalDirectoryObjectId = $null
        createdByAdminForge       = $false
        ownerObjectIds            = @()
    }
    try {
        $r = Get-EXORecipient -Identity $Value -Properties CustomAttribute15, ManagedBy |
            Select-Object DisplayName, PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId, CustomAttribute15, ManagedBy
    } catch {
        $text = "$($_.Exception.Message) $($_.FullyQualifiedErrorId)"
        if ($text -match "couldn't find object|couldn't be found|ManagementObjectNotFound") { return $item }
        if ($text -match 'matches multiple entries|ManagementObjectAmbiguous') {
            throw (New-AdminForgeError -Category input -Message "More than one recipient answers to $Value. Pick another address or alias.")
        }
        Write-AdminForgeLog -Level Warn "Looking up $Value failed: $($_.Exception.Message)"
        throw (New-AdminForgeError -Category script -Message "Exchange couldn't check $Value just now, so nothing was decided. Try again in a few minutes.")
    }
    $type = [string]$r.RecipientTypeDetails
    $item.taken = $true
    $item.recipientTypeDetails = $type
    $item.typeLabel = if ($labels.ContainsKey($type)) { $labels[$type] } else { 'another recipient' }
    $item.displayName = [string]$r.DisplayName
    $item.primarySmtpAddress = [string]$r.PrimarySmtpAddress
    $item.externalDirectoryObjectId = [string]$r.ExternalDirectoryObjectId
    $item.createdByAdminForge = ([string]$r.CustomAttribute15).StartsWith('AdminForge-created')
    # Owners come back as recipient names (or object ids); resolve each to its Entra object id. One that can't be
    # resolved is left out (the playbooks then treat the engineer as not an owner, which only ever refuses).
    $owners = [System.Collections.Generic.List[string]]::new()
    foreach ($name in @($r.ManagedBy | Where-Object { $_ })) {
        try {
            $o = Get-EXORecipient -Identity ([string]$name) | Select-Object ExternalDirectoryObjectId
            if ([string]$o.ExternalDirectoryObjectId) { $owners.Add(([string]$o.ExternalDirectoryObjectId).ToLowerInvariant()) }
        } catch {
            Write-AdminForgeLog -Level Warn "Could not resolve an owner of $Value"
        }
    }
    $item.ownerObjectIds = $owners.ToArray()
    $item
}

$items = [System.Collections.Generic.List[object]]::new()
$total = $addresses.Count + $aliases.Count
$done = 0
foreach ($a in $addresses) {
    $done++
    Write-AdminForgeProgress -Percent (20 + [Math]::Floor(75 * $done / $total)) -Message "Checking $a"
    $items.Add((Find-Recipient $a 'address'))
}
foreach ($a in $aliases) {
    $done++
    Write-AdminForgeProgress -Percent (20 + [Math]::Floor(75 * $done / $total)) -Message "Checking $a"
    $items.Add((Find-Recipient $a 'alias'))
}

Write-AdminForgeOutput -Data ([ordered]@{ acceptedDomains = $domains; items = $items.ToArray() })
Write-AdminForgeProgress -Percent 100 -Message 'Done'
