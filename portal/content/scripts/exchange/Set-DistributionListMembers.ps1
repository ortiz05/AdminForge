<#
.SYNOPSIS
    Adds and/or removes members of a distribution list or mail-enabled security group.

.DESCRIPTION
    Reads the current members, then adds only addresses that are not members yet and removes only addresses
    that are members (idempotent). Refuses to add the person running it under any of their addresses (a
    mail-enabled security group grants access like any security group). Each change is attempted separately;
    the result lists what was added, removed, skipped and failed. If any change fails the job fails after
    reporting the result.

.PARAMETER Inputs
    identity                          string    Required. Primary SMTP address of the group.
    add                               string[]  SMTP addresses to add (up to 1000).
    remove                            string[]  SMTP addresses to remove (up to 1000).
    bypassSecurityGroupManagerCheck   bool      Pass -BypassSecurityGroupManagerCheck (needs Organization
                                                Management; default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ group; displayName; added; removed; skipped = @(@{ member; reason }); failed = @(@{ member; action; error });
       memberCountBefore; memberCountAfter }

.NOTES
    Tokens: exchange. Mode: write. Exchange role: Distribution Groups (or group owner).
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Context['Mode'] -ne 'write') {
    throw (New-AdminForgeError -Category readOnly -Message 'Changing group membership changes data; run this script in write mode (armed session).')
}
$smtp = '^[^\s@]+@[^\s@]+\.[^\s@]+$'
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern $smtp -MaxLength 320
$addInput = Get-AdminForgeInput $Inputs 'add' -Type StringArray -Pattern $smtp -MaxLength 320 -MaxCount 1000
$removeInput = Get-AdminForgeInput $Inputs 'remove' -Type StringArray -Pattern $smtp -MaxLength 320 -MaxCount 1000
$add = @($addInput | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
$remove = @($removeInput | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
$bypass = Get-AdminForgeInput $Inputs 'bypassSecurityGroupManagerCheck' -Type Bool -Default $false

if ($add.Count -eq 0 -and $remove.Count -eq 0) {
    throw (New-AdminForgeError -Category input -Message "Provide at least one address in 'add' or 'remove'.")
}
$overlap = @($add | Where-Object { $remove -contains $_ })
if ($overlap.Count) {
    throw (New-AdminForgeError -Category input -Message "These addresses are in both 'add' and 'remove': $($overlap -join ', ')")
}

# Nobody adds themselves, under their sign-in name or any of their addresses (only Exchange knows the aliases).
if ($add.Count) {
    $me = if ($Context['User'] -is [System.Collections.IDictionary] -and $Context['User']['Upn']) { ([string]$Context['User']['Upn']).ToLowerInvariant() } else { '' }
    if (-not $me) {
        throw (New-AdminForgeError -Category script -Message "AdminForge couldn't tell who is running this, so nothing was changed. Sign in again and retry.")
    }
    $myId = if ($Context['User']['ObjectId']) { [string]$Context['User']['ObjectId'] } else { '' }
    $mine = [System.Collections.Generic.HashSet[string]]::new([string[]]@($me), [System.StringComparer]::OrdinalIgnoreCase)
    try {
        # By object id when the runner has it: a sign-in name Exchange hasn't caught up with would find nobody.
        $self = Get-EXORecipient -Identity $(if ($myId) { $myId } else { $me }) -Properties EmailAddresses | Select-Object PrimarySmtpAddress, EmailAddresses
    } catch {
        if ("$($_.Exception.Message) $($_.FullyQualifiedErrorId)" -match "couldn't find object|couldn't be found|ManagementObjectNotFound") { $self = $null }
        else {
            Write-AdminForgeLog -Level Warn "Looking up your own addresses failed: $($_.Exception.Message)"
            throw (New-AdminForgeError -Category script -Message "Exchange couldn't check your own addresses just now, so nothing was changed. Try again in a few minutes.")
        }
    }
    if ($self) {
        if ($self.PrimarySmtpAddress) { [void]$mine.Add([string]$self.PrimarySmtpAddress) }
        foreach ($a in @($self.EmailAddresses)) { if ("$a" -match '^smtp:(.+)$') { [void]$mine.Add($Matches[1]) } }
    }
    $own = @($add | Where-Object { $mine.Contains($_) })
    if ($own.Count) {
        throw (New-AdminForgeError -Category input -Message "You can't add yourself ($($own -join ', ')) to a list or group. Ask another engineer to add you.")
    }
}

Write-AdminForgeProgress -Percent 5 -Message 'Reading group'
try {
    $group = Get-DistributionGroup -Identity $identity | Select-Object DisplayName, PrimarySmtpAddress, RecipientTypeDetails
} catch {
    throw (New-AdminForgeError -Category input -Message "Group '$identity' was not found: $($_.Exception.Message)")
}
$groupId = [string]$group.PrimarySmtpAddress

# A mail-enabled security group grants access: nesting another group or list in it would bring in everyone in that
# one (perhaps the person running this), past the check above. People and contacts only; nest groups by hand.
if ($add.Count -and [string]$group.RecipientTypeDetails -eq 'MailUniversalSecurityGroup') {
    $groupTypes = @('MailUniversalSecurityGroup', 'MailUniversalDistributionGroup', 'DynamicDistributionGroup', 'GroupMailbox', 'RoomList')
    $nested = @(foreach ($member in $add) {
            try {
                $r = Get-EXORecipient -Identity $member | Select-Object RecipientTypeDetails
            } catch {
                if ("$($_.Exception.Message) $($_.FullyQualifiedErrorId)" -match "couldn't find object|couldn't be found|ManagementObjectNotFound") { continue }
                Write-AdminForgeLog -Level Warn "Looking up $member failed: $($_.Exception.Message)"
                throw (New-AdminForgeError -Category script -Message "Exchange couldn't check $member just now, so nothing was changed. Try again in a few minutes.")
            }
            if ($r -and [string]$r.RecipientTypeDetails -in $groupTypes) { $member }
        })
    if ($nested.Count) {
        throw (New-AdminForgeError -Category input -Message "$($group.DisplayName) is a mail-enabled security group, so AdminForge adds people to it, not other groups or lists ($($nested -join ', ')). Ask another engineer to nest them in the Exchange admin center; nothing was changed.")
    }
}

function Get-MemberAddresses {
    @(Get-DistributionGroupMember -Identity $groupId -ResultSize Unlimited | Select-Object PrimarySmtpAddress |
            ForEach-Object { ([string]$_.PrimarySmtpAddress).ToLowerInvariant() } | Where-Object { $_ })
}
$current = [System.Collections.Generic.HashSet[string]]::new([string[]]@(Get-MemberAddresses), [System.StringComparer]::OrdinalIgnoreCase)
Write-AdminForgeLog "$groupId has $($current.Count) members before the change"

$added = [System.Collections.Generic.List[string]]::new()
$removed = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[object]]::new()
$failed = [System.Collections.Generic.List[object]]::new()
$common = @{ Identity = $groupId; Confirm = $false }
if ($bypass) { $common.BypassSecurityGroupManagerCheck = $true }

$total = $add.Count + $remove.Count
$done = 0
foreach ($member in $add) {
    $done++
    Write-AdminForgeProgress -Percent (10 + [Math]::Floor(80 * $done / $total)) -Message "Adding $member"
    if ($current.Contains($member)) { $skipped.Add([ordered]@{ member = $member; reason = 'already a member' }); continue }
    try {
        Add-DistributionGroupMember @common -Member $member
        $added.Add($member)
    } catch {
        $failed.Add([ordered]@{ member = $member; action = 'add'; error = $_.Exception.Message })
        Write-AdminForgeLog -Level Error "Could not add ${member}: $($_.Exception.Message)"
    }
}
foreach ($member in $remove) {
    $done++
    Write-AdminForgeProgress -Percent (10 + [Math]::Floor(80 * $done / $total)) -Message "Removing $member"
    if (-not $current.Contains($member)) { $skipped.Add([ordered]@{ member = $member; reason = 'not a member' }); continue }
    try {
        Remove-DistributionGroupMember @common -Member $member
        $removed.Add($member)
    } catch {
        $failed.Add([ordered]@{ member = $member; action = 'remove'; error = $_.Exception.Message })
        Write-AdminForgeLog -Level Error "Could not remove ${member}: $($_.Exception.Message)"
    }
}

Write-AdminForgeProgress -Percent 95 -Message 'Reading members back'
$after = @(Get-MemberAddresses)
$result = [ordered]@{
    group             = $groupId
    displayName       = [string]$group.DisplayName
    added             = $added.ToArray()
    removed           = $removed.ToArray()
    skipped           = $skipped.ToArray()
    failed            = $failed.ToArray()
    memberCountBefore = $current.Count
    memberCountAfter  = $after.Count
}
Write-AdminForgeOutput -Data $result
Write-AdminForgeProgress -Percent 100 -Message 'Done'
if ($failed.Count) {
    throw "$($failed.Count) of $total membership changes failed; see the output for details."
}
