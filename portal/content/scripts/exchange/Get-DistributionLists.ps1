<#
.SYNOPSIS
    Lists distribution lists and mail-enabled security groups with their delivery settings.

.DESCRIPTION
    Reads groups with Get-DistributionGroup and reports owners, join/leave restrictions and whether external
    senders are accepted. Optionally counts members (one Get-DistributionGroupMember call per group).

.PARAMETER Inputs
    resultSize            int     Maximum groups to read, 1-50000 (default 5000).
    groupType             string  All (default), Distribution, or MailEnabledSecurity.
    includeMemberCounts   bool    Count members of each group (default false; slow on large tenants).
    maxGroupsForMembers   int     Count members for at most this many groups, 1-2000 (default 200).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ total; truncated; byType = @(@{ type; count }); acceptExternalSenders;
       groups = @(@{ displayName; primarySmtpAddress; alias; recipientTypeDetails; managedBy; memberJoinRestriction;
                     memberDepartRestriction; requireSenderAuthenticationEnabled; hiddenFromAddressListsEnabled;
                     isDirSynced; whenCreated; memberCount; createdByAdminForge }) }

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

$resultSize = Get-AdminForgeInput $Inputs 'resultSize' -Type Int -Default 5000 -Minimum 1 -Maximum 50000
$groupType = Get-AdminForgeInput $Inputs 'groupType' -Default 'All' -AllowedValues 'All', 'Distribution', 'MailEnabledSecurity'
$includeMemberCounts = Get-AdminForgeInput $Inputs 'includeMemberCounts' -Type Bool -Default $false
$maxGroupsForMembers = Get-AdminForgeInput $Inputs 'maxGroupsForMembers' -Type Int -Default 200 -Minimum 1 -Maximum 2000

$typeDetails = switch ($groupType) {
    'Distribution' { @('MailUniversalDistributionGroup') }
    'MailEnabledSecurity' { @('MailUniversalSecurityGroup') }
    default { @('MailUniversalDistributionGroup', 'MailUniversalSecurityGroup') }
}

Write-AdminForgeProgress -Percent 5 -Message 'Reading groups'
$raw = @(Get-DistributionGroup -ResultSize $resultSize -RecipientTypeDetails $typeDetails)
Write-AdminForgeLog "Read $($raw.Count) groups"

$rows = @($raw | Select-Object DisplayName, PrimarySmtpAddress, Alias, RecipientTypeDetails, ManagedBy, MemberJoinRestriction,
    MemberDepartRestriction, RequireSenderAuthenticationEnabled, HiddenFromAddressListsEnabled, IsDirSynced, WhenCreated,
    CustomAttribute15)

$groups = [System.Collections.Generic.List[object]]::new()
$i = 0
foreach ($row in $rows) {
    $i++
    $memberCount = $null
    if ($includeMemberCounts -and $i -le $maxGroupsForMembers) {
        if ($i % 10 -eq 0) { Write-AdminForgeProgress -Percent (10 + [Math]::Floor(85 * $i / [Math]::Min($rows.Count, $maxGroupsForMembers))) -Message "Counting members ($i)" }
        try {
            $memberCount = @(Get-DistributionGroupMember -Identity ([string]$row.PrimarySmtpAddress) -ResultSize Unlimited).Count
        } catch {
            Write-AdminForgeLog -Level Warn "Could not read members of $($row.PrimarySmtpAddress): $($_.Exception.Message)"
        }
    }
    $groups.Add([ordered]@{
            displayName                        = [string]$row.DisplayName
            primarySmtpAddress                 = [string]$row.PrimarySmtpAddress
            alias                              = [string]$row.Alias
            recipientTypeDetails               = [string]$row.RecipientTypeDetails
            managedBy                          = @($row.ManagedBy | Where-Object { $_ } | ForEach-Object { [string]$_ })
            memberJoinRestriction              = [string]$row.MemberJoinRestriction
            memberDepartRestriction            = [string]$row.MemberDepartRestriction
            requireSenderAuthenticationEnabled = [bool]$row.RequireSenderAuthenticationEnabled
            hiddenFromAddressListsEnabled      = [bool]$row.HiddenFromAddressListsEnabled
            isDirSynced                        = [bool]$row.IsDirSynced
            whenCreated                        = if ($row.WhenCreated) { ([datetime]$row.WhenCreated).ToUniversalTime().ToString('o') } else { $null }
            memberCount                        = $memberCount
            # Set by AdminForge's create playbook; the page offers removal only for these.
            createdByAdminForge                = ([string]$row.CustomAttribute15).StartsWith('AdminForge-created')
        })
}
if ($includeMemberCounts -and $rows.Count -gt $maxGroupsForMembers) {
    Write-AdminForgeLog -Level Warn "Member counts limited to the first $maxGroupsForMembers groups"
}

$result = [ordered]@{
    total                 = $groups.Count
    truncated             = ($groups.Count -ge $resultSize)
    byType                = @($groups | Group-Object { $_.recipientTypeDetails } | ForEach-Object { [ordered]@{ type = [string]$_.Name; count = $_.Count } })
    acceptExternalSenders = @($groups | Where-Object { -not $_.requireSenderAuthenticationEnabled }).Count
    groups                = $groups.ToArray()
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
