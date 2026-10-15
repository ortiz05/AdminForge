<#
.SYNOPSIS
    Summarises Exchange Online mailboxes by type, with key compliance flags.

.DESCRIPTION
    Reads mailboxes with Get-EXOMailbox and reports counts per RecipientTypeDetails, how many are hidden
    from the address list, on litigation hold, or archive-enabled, plus one row per mailbox.

.PARAMETER Inputs
    resultSize            int       Maximum mailboxes to read, 1-100000 (default 5000).
    recipientTypeDetails  string[]  Limit to these types: UserMailbox, SharedMailbox, RoomMailbox,
                                    EquipmentMailbox, SchedulingMailbox (default: all of them).
    includeMailboxes      bool      Include the per-mailbox rows (default true).
    includeAccountState   bool      Also return each mailbox's Entra object id and whether sign-in is blocked for its
                                    account (externalDirectoryObjectId, accountDisabled), e.g. to find shared
                                    mailboxes people can sign in to (default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ total; truncated; byType = @(@{ type; count }); hiddenFromAddressLists; litigationHold; archiveEnabled;
       mailboxes = @(@{ displayName; userPrincipalName; primarySmtpAddress; recipientTypeDetails; whenCreated;
                        hiddenFromAddressListsEnabled; litigationHoldEnabled; archiveStatus
                        [; externalDirectoryObjectId; accountDisabled] }) }

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

$types = 'UserMailbox', 'SharedMailbox', 'RoomMailbox', 'EquipmentMailbox', 'SchedulingMailbox'
$resultSize = Get-AdminForgeInput $Inputs 'resultSize' -Type Int -Default 5000 -Minimum 1 -Maximum 100000
$typeFilter = Get-AdminForgeInput $Inputs 'recipientTypeDetails' -Type StringArray -AllowedValues $types -MaxCount 5
$includeMailboxes = Get-AdminForgeInput $Inputs 'includeMailboxes' -Type Bool -Default $true
$includeAccountState = Get-AdminForgeInput $Inputs 'includeAccountState' -Type Bool -Default $false
if ($typeFilter.Count -eq 0) { $typeFilter = $types }

Write-AdminForgeProgress -Percent 5 -Message 'Reading mailboxes'
$properties = 'WhenCreated', 'HiddenFromAddressListsEnabled', 'LitigationHoldEnabled', 'ArchiveStatus'
if ($includeAccountState) { $properties += 'AccountDisabled' }
$raw = @(Get-EXOMailbox -ResultSize $resultSize -RecipientTypeDetails $typeFilter -Properties $properties)
Write-AdminForgeLog "Read $($raw.Count) mailboxes"
Write-AdminForgeProgress -Percent 70 -Message 'Summarising'

$rows = @($raw | Select-Object DisplayName, UserPrincipalName, PrimarySmtpAddress, RecipientTypeDetails, WhenCreated,
    HiddenFromAddressListsEnabled, LitigationHoldEnabled, ArchiveStatus, ExternalDirectoryObjectId, AccountDisabled)

$byType = @($rows | Group-Object -Property RecipientTypeDetails | Sort-Object -Property Count -Descending | ForEach-Object {
        [ordered]@{ type = [string]$_.Name; count = $_.Count }
    })

$result = [ordered]@{
    total                  = $rows.Count
    truncated              = ($rows.Count -ge $resultSize)
    byType                 = $byType
    hiddenFromAddressLists = @($rows | Where-Object { $_.HiddenFromAddressListsEnabled -eq $true }).Count
    litigationHold         = @($rows | Where-Object { $_.LitigationHoldEnabled -eq $true }).Count
    archiveEnabled         = @($rows | Where-Object { [string]$_.ArchiveStatus -eq 'Active' }).Count
}
if ($includeMailboxes) {
    $result.mailboxes = @($rows | ForEach-Object {
            $row = [ordered]@{
                displayName                   = [string]$_.DisplayName
                userPrincipalName             = [string]$_.UserPrincipalName
                primarySmtpAddress            = [string]$_.PrimarySmtpAddress
                recipientTypeDetails          = [string]$_.RecipientTypeDetails
                whenCreated                   = if ($_.WhenCreated) { ([datetime]$_.WhenCreated).ToUniversalTime().ToString('o') } else { $null }
                hiddenFromAddressListsEnabled = [bool]$_.HiddenFromAddressListsEnabled
                litigationHoldEnabled         = [bool]$_.LitigationHoldEnabled
                archiveStatus                 = [string]$_.ArchiveStatus
            }
            if ($includeAccountState) {
                # null = Exchange didn't say (treated as unknown, not as blocked).
                $row.externalDirectoryObjectId = if ($_.ExternalDirectoryObjectId) { [string]$_.ExternalDirectoryObjectId } else { $null }
                $row.accountDisabled = if ($null -eq $_.AccountDisabled) { $null } else { [System.Convert]::ToBoolean($_.AccountDisabled) }
            }
            $row
        })
}
if ($result.truncated) { Write-AdminForgeLog -Level Warn "Stopped at resultSize $resultSize; there may be more mailboxes" }

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
