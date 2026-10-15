<#
.SYNOPSIS
    Summarises Microsoft Teams: visibility, archived teams and (optionally) ownerless teams.

.DESCRIPTION
    Reads all teams with Get-Team. With includeOwnerCounts, counts owners per team with Get-TeamUser and
    lists teams that have no owner.

.PARAMETER Inputs
    includeOwnerCounts   bool  Count owners per team (default false; one call per team).
    maxTeamsForOwners    int   Count owners for at most this many teams, 1-2000 (default 200).
    includeTeams         bool  Include the per-team rows (default true).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ total; archived; byVisibility = @(@{ visibility; count }); ownerless = @(@{ groupId; displayName });
       teams = @(@{ groupId; displayName; visibility; archived; mailNickName; ownerCount }) }

.NOTES
    Tokens: graph + teams. Mode: read. Role: Teams Administrator (or Global Reader).
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$includeOwnerCounts = Get-AdminForgeInput $Inputs 'includeOwnerCounts' -Type Bool -Default $false
$maxTeamsForOwners = Get-AdminForgeInput $Inputs 'maxTeamsForOwners' -Type Int -Default 200 -Minimum 1 -Maximum 2000
$includeTeams = Get-AdminForgeInput $Inputs 'includeTeams' -Type Bool -Default $true

Write-AdminForgeProgress -Percent 5 -Message 'Reading teams'
$rows = @(Get-Team | Select-Object GroupId, DisplayName, Visibility, Archived, MailNickName)
Write-AdminForgeLog "Read $($rows.Count) teams"

$teams = [System.Collections.Generic.List[object]]::new()
$i = 0
foreach ($row in $rows) {
    $i++
    $ownerCount = $null
    if ($includeOwnerCounts -and $i -le $maxTeamsForOwners) {
        if ($i % 10 -eq 0) { Write-AdminForgeProgress -Percent (10 + [Math]::Floor(85 * $i / [Math]::Min($rows.Count, $maxTeamsForOwners))) -Message "Counting owners ($i)" }
        try {
            $ownerCount = @(Get-TeamUser -GroupId ([string]$row.GroupId) -Role Owner).Count
        } catch {
            Write-AdminForgeLog -Level Warn "Could not read owners of $($row.DisplayName): $($_.Exception.Message)"
        }
    }
    $teams.Add([ordered]@{
            groupId      = [string]$row.GroupId
            displayName  = [string]$row.DisplayName
            visibility   = [string]$row.Visibility
            archived     = [bool]$row.Archived
            mailNickName = [string]$row.MailNickName
            ownerCount   = $ownerCount
        })
}

$all = $teams.ToArray()
$result = [ordered]@{
    total        = $all.Count
    archived     = @($all | Where-Object { $_.archived }).Count
    byVisibility = @($all | Group-Object { $_.visibility } | ForEach-Object { [ordered]@{ visibility = [string]$_.Name; count = $_.Count } })
    ownerless    = @($all | Where-Object { $_.ownerCount -eq 0 } | ForEach-Object { [ordered]@{ groupId = $_.groupId; displayName = $_.displayName } })
}
if ($includeTeams) { $result.teams = $all }
if ($includeOwnerCounts -and $rows.Count -gt $maxTeamsForOwners) { Write-AdminForgeLog -Level Warn "Owner counts limited to the first $maxTeamsForOwners teams" }

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
