<#
.SYNOPSIS
    Adds or removes one site collection administrator of a person's OneDrive through the SharePoint admin centre, and
    reads the administrators back.

.DESCRIPTION
    OneDrives only: siteUrl must be a OneDrive of this tenant (https://<tenant>-my.sharepoint.<cloud>/personal/<name>).
    Team and communication sites are refused; if they are ever needed, add a separate, explicitly reviewed parameter
    for them rather than widening this one (no playbook uses one today).
    Works through the tenant admin API, so the caller needs no access to the OneDrive itself (a SharePoint
    Administrator can't open other people's OneDrives). Before anything changes it confirms whose OneDrive it is: the
    owner's user profile (Get-PnPUserProfileProperty) must point at siteUrl and carry ownerObjectId (msOnline-ObjectId),
    and the site's primary owner (Get-PnPTenantSite) must be owner. The person's own profile, when SharePoint has one,
    must carry userObjectId. The object ids are inputs so AdminForge's protected-object guard sees whose OneDrive and
    whose access this is before the write runs. Nobody adds themselves (Context.User).
    Then it reads the secondary administrators (Tenant/GetSiteSecondaryAdministrators), changes only what differs and
    reads them back:
      add     Set-PnPTenantSite -Owners — adds the person; existing administrators keep their access.
      remove  Tenant/SetSiteSecondaryAdministrators with every other administrator kept as they were; afterwards every
              one of them must still be listed, otherwise the script fails and names who to add back.
    The primary administrator (the OneDrive's owner) is never removed. Idempotent: nothing is sent when the person
    already has (add) or doesn't have (remove) the access — except with force, which undoes a grant SharePoint hasn't
    shown yet. SharePoint can take a while to list a change: the read-back is retried for about 30 seconds whether or
    not anything was sent. An add that still doesn't show is returned with verified = false (the playbook decides); a
    remove after which the person is still listed fails, so an undo is never reported as done when it isn't.

.PARAMETER Inputs
    siteUrl         string  Required. The OneDrive: https://<tenant>-my.sharepoint.<cloud>/personal/<name>.
    owner           string  Required. UPN of the OneDrive's owner; nothing changes unless the site is theirs.
    ownerObjectId   string  Required. Entra object id of the owner.
    user            string  Required. UPN of the administrator to add or remove.
    userObjectId    string  Required. Entra object id of that person.
    action          string  Required. add | remove.
    force           bool    Optional (remove only). Send the removal even when the person isn't listed (default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant (SpoTenantName required), Services, User.

.OUTPUTS
    @{ siteUrl; user; action; before; after; changed; verified; administrators; missingAdministrators }
    before/after: whether the user was a secondary administrator before and after; administrators: how many
    secondary administrators the OneDrive has afterwards; missingAdministrators: other administrators SharePoint no
    longer lists after a removal (empty when all were kept).

.NOTES
    Tokens: sharepointAdmin. Mode: write. Role: SharePoint Administrator.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Context['Mode'] -ne 'write') {
    throw (New-AdminForgeError -Category readOnly -Message 'Changing site administrators changes data; run this script in write mode (armed session).')
}
$upnPattern = '^[^\s@]+@[^\s@]+\.[^\s@]+$'
$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$siteUrl = (Get-AdminForgeInput $Inputs 'siteUrl' -Required -Pattern '^https://[A-Za-z0-9-]+-my\.sharepoint\.(com|us|cn)/personal/[A-Za-z0-9_-]+/?$' -MaxLength 400).TrimEnd('/')
$owner = Get-AdminForgeInput $Inputs 'owner' -Required -Pattern $upnPattern -MaxLength 320
$ownerObjectId = Get-AdminForgeInput $Inputs 'ownerObjectId' -Required -Pattern $guid
$user = Get-AdminForgeInput $Inputs 'user' -Required -Pattern $upnPattern -MaxLength 320
$userObjectId = Get-AdminForgeInput $Inputs 'userObjectId' -Required -Pattern $guid
$action = Get-AdminForgeInput $Inputs 'action' -Required -AllowedValues @('add', 'remove')
$force = Get-AdminForgeInput $Inputs 'force' -Type Bool -Default $false
$tenant = $Context['Tenant']
$tenantName = if ($tenant -is [System.Collections.IDictionary]) { [string]$tenant['SpoTenantName'] } else { '' }
if ($tenantName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
    throw (New-AdminForgeError -Category runner -Message 'The SharePoint tenant name is not configured (AF_SPO_TENANT_NAME).')
}
$oneDrivePattern = "^https://$([regex]::Escape($tenantName.ToLowerInvariant()))-my\.sharepoint\.(com|us|cn)/personal/[a-z0-9_-]+$"
if ($siteUrl.ToLowerInvariant() -notmatch $oneDrivePattern) {
    throw (New-AdminForgeError -Category input -Message "'$siteUrl' is not a OneDrive of this tenant; nothing was changed.")
}
if ($userObjectId -ieq $ownerObjectId -or $user -ieq $owner) {
    throw (New-AdminForgeError -Category input -Message "$user owns this OneDrive and always keeps access to it; nothing was changed. Pick someone else.")
}
$caller = $Context['User']
$callerOid = if ($caller -is [System.Collections.IDictionary] -and $caller['ObjectId']) { [string]$caller['ObjectId'] } else { '' }
$callerUpn = if ($caller -is [System.Collections.IDictionary] -and $caller['Upn']) { [string]$caller['Upn'] } else { '' }
if ($action -eq 'add' -and (($callerOid -and $userObjectId -ieq $callerOid) -or ($callerUpn -and $user -ieq $callerUpn))) {
    throw (New-AdminForgeError -Category input -Message "You can't give yourself access to someone's OneDrive. Ask another engineer, or give it to their manager; nothing was changed.")
}

# A profile property (PnP returns CSOM PersonProperties: UserProfileProperties is a dictionary), or ''.
function Get-ProfileValue($UserProfile, [string]$Name) {
    if (-not $UserProfile) { return '' }
    if ($UserProfile.PSObject.Properties[$Name]) { return [string]$UserProfile.$Name }
    $props = if ($UserProfile.PSObject.Properties['UserProfileProperties']) { $UserProfile.UserProfileProperties } else { $null }
    # Keys works for a hashtable and for the generic Dictionary (whose Contains isn't callable from PowerShell).
    if ($props -is [System.Collections.IDictionary]) { if (@($props.Keys) -contains $Name) { return [string]$props[$Name] } else { return '' } }
    if ($props -and $props.PSObject.Properties[$Name]) { return [string]$props.$Name }
    ''
}

Write-AdminForgeProgress -Percent 5 -Message "Checking whose OneDrive this is"
try {
    $ownerProfile = Get-PnPUserProfileProperty -Account $owner
    $personalUrl = (Get-ProfileValue $ownerProfile 'PersonalUrl').TrimEnd('/')
    $ownerProfileId = Get-ProfileValue $ownerProfile 'msOnline-ObjectId'
} catch {
    throw (New-AdminForgeError -Category input -Message "Could not read the user profile of ${owner}: $($_.Exception.Message)")
}
if ($personalUrl -ine $siteUrl) {
    throw (New-AdminForgeError -Category input -Message "'$siteUrl' is not the OneDrive of $owner; nothing was changed. Start over from the person.")
}
if (-not $ownerProfileId) {
    throw (New-AdminForgeError -Category script -Message "SharePoint's profile of $owner doesn't say which account it belongs to, so AdminForge couldn't confirm whose OneDrive this is; nothing was changed. Try again in a few minutes, or change the access in the SharePoint admin center.")
}
if ($ownerProfileId -ine $ownerObjectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $owner doesn't match their OneDrive, so nothing was changed. Start over from the person.")
}
$userProfileId = ''
try {
    $userProfileId = Get-ProfileValue (Get-PnPUserProfileProperty -Account $user) 'msOnline-ObjectId'
} catch {
    Write-AdminForgeLog "SharePoint has no profile for ${user}: $($_.Exception.Message)"
}
if (-not $userProfileId) { Write-AdminForgeLog "SharePoint's profile doesn't name the account of $user; the playbook's lookup is used" }
if ($userProfileId -and $userProfileId -ine $userObjectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $user doesn't match their SharePoint profile, so nothing was changed. Start over from the person.")
}

$adminApi = '/_api/Microsoft.Online.SharePoint.TenantAdministration.Tenant'
function Get-SecondaryAdministrators([string]$SiteId) {
    $response = Invoke-PnPSPRestMethod -Method Post -Url "$adminApi/GetSiteSecondaryAdministrators" -Content @{
        secondaryAdministratorsFieldsData = @{ siteId = $SiteId }
    }
    $items = if ($null -ne $response -and $response.PSObject.Properties['value']) { @($response.value) } else { @($response) }
    @($items | Where-Object { $null -ne $_ } | ForEach-Object {
            [ordered]@{
                loginName         = [string]$_.loginName
                email             = [string]$_.email
                userPrincipalName = [string]$_.userPrincipalName
            }
        })
}
function Test-IsUser($Administrator) {
    $Administrator.userPrincipalName -ieq $user -or $Administrator.email -ieq $user -or
    $Administrator.loginName.EndsWith("|$user", [System.StringComparison]::OrdinalIgnoreCase)
}

Write-AdminForgeProgress -Percent 15 -Message 'Reading the OneDrive'
$site = $null
try {
    $site = Get-PnPTenantSite -Identity $siteUrl | Select-Object Url, SiteId, Owner, OwnerEmail
} catch {
    throw (New-AdminForgeError -Category input -Message "The OneDrive '$siteUrl' was not found: $($_.Exception.Message)")
}
if (-not $site -or -not $site.SiteId) { throw (New-AdminForgeError -Category input -Message "The OneDrive '$siteUrl' was not found.") }
$siteId = [string]$site.SiteId
$primary = @([string]$site.Owner, [string]$site.OwnerEmail) | Where-Object { $_ }
if (-not ($primary | Where-Object { $_ -ieq $owner -or $_.EndsWith("|$owner", [System.StringComparison]::OrdinalIgnoreCase) })) {
    throw (New-AdminForgeError -Category input -Message "The OneDrive '$siteUrl' doesn't belong to $owner; nothing was changed.")
}
if ($action -eq 'remove' -and ($primary | Where-Object { $_ -ieq $user })) {
    throw (New-AdminForgeError -Category input -Message "$user is the OneDrive's primary administrator (its owner), which this doesn't remove; nothing was changed.")
}

Write-AdminForgeProgress -Percent 30 -Message 'Reading the administrators'
$before = @(Get-SecondaryAdministrators $siteId)
$had = @($before | Where-Object { Test-IsUser $_ }).Count -gt 0
$keep = @($before | Where-Object { -not (Test-IsUser $_) -and $_.loginName } | ForEach-Object { $_.loginName })

$changed = $false
if ($action -eq 'add' -and -not $had) {
    Write-AdminForgeLog "Adding $user as a site collection administrator of $siteUrl"
    Set-PnPTenantSite -Identity $siteUrl -Owners @($user)
    $changed = $true
} elseif ($action -eq 'remove' -and ($had -or $force)) {
    Write-AdminForgeLog "Removing $user from the site collection administrators of $siteUrl ($($keep.Count) others kept)"
    $null = Invoke-PnPSPRestMethod -Method Post -Url "$adminApi/SetSiteSecondaryAdministrators" -Content @{
        secondaryAdministratorsFieldsData = @{ siteId = $siteId; secondaryAdministratorLoginNames = $keep }
    }
    $changed = $true
}

# Read back whether or not anything was sent: SharePoint can be slow to list an administrator (also one who was
# already there), and a removal must leave everyone else in place.
Write-AdminForgeProgress -Percent 70 -Message 'Reading the administrators back'
$want = $action -eq 'add'
$checkOthers = $action -eq 'remove' -and $changed
function Get-Missing($Administrators) {
    if (-not $checkOthers) { return @() }
    $listed = @($Administrators | ForEach-Object { $_.loginName })
    @($keep | Where-Object { $listed -notcontains $_ })
}
$after = @(Get-SecondaryAdministrators $siteId)
$has = @($after | Where-Object { Test-IsUser $_ }).Count -gt 0
$missing = @(Get-Missing $after)
for ($try = 1; ($has -ne $want -or $missing.Count) -and $try -le 6; $try++) {
    Start-Sleep -Seconds 5
    $after = @(Get-SecondaryAdministrators $siteId)
    $has = @($after | Where-Object { Test-IsUser $_ }).Count -gt 0
    $missing = @(Get-Missing $after)
}

$result = [ordered]@{
    siteUrl               = $siteUrl
    user                  = $user
    action                = $action
    before                = $had
    after                 = $has
    changed               = $changed
    verified              = $has -eq $want -and -not $missing.Count
    administrators        = $after.Count
    missingAdministrators = $missing
}
Write-AdminForgeOutput -Data $result
if ($missing.Count) {
    throw (New-AdminForgeError -Category script -Message "After removing $user, SharePoint no longer lists $($missing.Count) other administrator(s) of ${siteUrl}: $($missing -join ', '). Add them back in the SharePoint admin center (Active sites › the OneDrive › Permissions) now, and report this to a portal administrator.")
}
if ($action -eq 'remove' -and $has) {
    throw (New-AdminForgeError -Category script -Message "SharePoint still lists $user as an administrator of $siteUrl. Check again in a few minutes; if they are still listed, remove them in the SharePoint admin center (Active sites › the OneDrive › Permissions).")
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
