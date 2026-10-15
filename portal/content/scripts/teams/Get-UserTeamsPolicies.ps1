<#
.SYNOPSIS
    The Teams policies in effect for one user (messaging, meetings, calling, app setup and more) and where each comes
    from: assigned directly, inherited from a group, or the org-wide default (Global).

.DESCRIPTION
    Reads the user with Get-CsOnlineUser (directly assigned policies) and Get-CsUserPolicyAssignment (effective
    policies with their sources, including group assignments and their priority). A policy type that neither lists
    is the org-wide default. Policy names prefixed "Tag:" by older module versions are shown without the prefix.

.PARAMETER Inputs
    identity   string  Required. User principal name (sign-in name).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ user = @{ displayName; userPrincipalName; accountEnabled; interpretedUserType; teamsUpgradeEffectiveMode;
                 usageLocation };
       summary = @{ direct; group; default };
       policies = @(@{ policyType; label; area; policyName; assignment = 'Direct'|'Group'|'Default'; groupId;
                       priority }) }

.NOTES
    Tokens: graph + teams. Mode: read. Role: Teams Administrator, Teams Communications Administrator or Global Reader.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320

# Policy type → label and area, in display order. The first four are the ones people ask about most.
$catalog = [ordered]@{
    TeamsMessagingPolicy         = @('Messaging', 'Core')
    TeamsMeetingPolicy           = @('Meetings', 'Core')
    TeamsCallingPolicy           = @('Calling', 'Core')
    TeamsAppSetupPolicy          = @('App setup', 'Core')
    TeamsAppPermissionPolicy     = @('App permission', 'Apps')
    TeamsChannelsPolicy          = @('Teams and channels', 'Collaboration')
    TeamsMeetingBroadcastPolicy  = @('Live events', 'Meetings')
    TeamsEventsPolicy            = @('Events and webinars', 'Meetings')
    TeamsUpdateManagementPolicy  = @('Update management', 'Client')
    TeamsFeedbackPolicy          = @('Feedback', 'Client')
    TeamsEmergencyCallingPolicy  = @('Emergency calling', 'Voice')
    TeamsVoiceApplicationsPolicy = @('Voice applications', 'Voice')
    OnlineVoiceRoutingPolicy     = @('Voice routing', 'Voice')
    CallingLineIdentity          = @('Caller ID', 'Voice')
    TenantDialPlan               = @('Dial plan', 'Voice')
}

function ConvertTo-PolicyName($Value) {
    if ($null -eq $Value) { return $null }
    $name = if ($Value -is [string]) { $Value } elseif ($Value.PSObject.Properties['Name']) { [string]$Value.Name } else { [string]$Value }
    if ($name -match '^Tag:(.+)$') { $name = $Matches[1] }
    if ([string]::IsNullOrWhiteSpace($name)) { return $null }
    $name
}

Write-AdminForgeProgress -Percent 10 -Message 'Reading the user'
$select = @('DisplayName', 'UserPrincipalName', 'AccountEnabled', 'InterpretedUserType', 'TeamsUpgradeEffectiveMode', 'UsageLocation') + @($catalog.Keys)
try {
    $user = Get-CsOnlineUser -Identity $identity | Select-Object -Property $select
} catch {
    throw (New-AdminForgeError -Category input -Message "Teams user '$identity' was not found: $($_.Exception.Message)")
}
if (-not $user) { throw (New-AdminForgeError -Category input -Message "Teams user '$identity' was not found.") }

Write-AdminForgeProgress -Percent 50 -Message 'Reading effective policy assignments'
$effective = @{}
try {
    foreach ($a in @(Get-CsUserPolicyAssignment -Identity $identity | Select-Object PolicyType, PolicyName, PolicySource)) {
        $effective[[string]$a.PolicyType] = $a
    }
} catch {
    Write-AdminForgeLog -Level Warn "Could not read group policy assignments; showing direct assignments only: $($_.Exception.Message)"
}

$policies = foreach ($type in $catalog.Keys) {
    $label, $area = $catalog[$type]
    $name = $null; $assignment = 'Default'; $groupId = $null; $priority = $null
    if ($effective.ContainsKey($type)) {
        $a = $effective[$type]
        $name = ConvertTo-PolicyName $a.PolicyName
        $sources = @(@($a.PolicySource) | Where-Object { $_ } | Select-Object AssignmentType, PolicyName, Reference, Priority)
        $direct = @($sources | Where-Object { [string]$_.AssignmentType -eq 'Direct' })
        $groups = @($sources | Where-Object { [string]$_.AssignmentType -eq 'Group' } | Sort-Object { [int]$_.Priority })
        if ($direct.Count) { $assignment = 'Direct' }
        elseif ($groups.Count) {
            $assignment = 'Group'
            $groupId = [string]$groups[0].Reference
            $priority = [int]$groups[0].Priority
        }
    }
    if (-not $name) {
        $name = ConvertTo-PolicyName $user.$type
        if ($name -and $assignment -eq 'Default') { $assignment = 'Direct' }
    }
    if (-not $name) { $name = 'Global'; $assignment = 'Default' }
    [ordered]@{
        policyType = $type
        label      = $label
        area       = $area
        policyName = $name
        assignment = $assignment
        groupId    = $groupId
        priority   = $priority
    }
}
$policies = @($policies)

$result = [ordered]@{
    user     = [ordered]@{
        displayName               = [string]$user.DisplayName
        userPrincipalName         = [string]$user.UserPrincipalName
        accountEnabled            = if ($null -ne $user.AccountEnabled) { [bool]$user.AccountEnabled } else { $null }
        interpretedUserType       = [string]$user.InterpretedUserType
        teamsUpgradeEffectiveMode = [string]$user.TeamsUpgradeEffectiveMode
        usageLocation             = [string]$user.UsageLocation
    }
    summary  = [ordered]@{
        direct  = @($policies | Where-Object { $_.assignment -eq 'Direct' }).Count
        group   = @($policies | Where-Object { $_.assignment -eq 'Group' }).Count
        default = @($policies | Where-Object { $_.assignment -eq 'Default' }).Count
    }
    policies = $policies
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
