<#
.SYNOPSIS
    Gives one person (usually a leaver's manager) access to another person's OneDrive by adding them as an
    additional site collection administrator.

.DESCRIPTION
    Finds the owner's OneDrive URL from their user profile (Get-PnPUserProfileProperty → PersonalUrl), checks that it
    is a OneDrive site of this tenant (https://<tenant>-my.sharepoint.<cloud>/personal/<name>), and adds the grantee
    with Set-PnPTenantSite -Owners, which adds site collection administrators without removing existing ones
    (idempotent). Both calls go through the SharePoint admin centre connection.
    The tenant admin API can't list secondary administrators, so the grant is not read back (verified = null).
    To take the access away later: SharePoint admin centre › Active sites › (OneDrive URL) › Permissions.

.PARAMETER Inputs
    owner     string  Required. UPN of the person whose OneDrive is shared.
    grantee   string  Required. UPN of the person who gets access.

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant (SpoTenantName required), Services, User.

.OUTPUTS
    @{ owner; grantee; oneDriveUrl; granted; verified; note }

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
    throw (New-AdminForgeError -Category readOnly -Message 'Granting OneDrive access changes data; run this script in write mode (armed session).')
}
$upn = '^[^\s@]+@[^\s@]+\.[^\s@]+$'
$owner = Get-AdminForgeInput $Inputs 'owner' -Required -Pattern $upn -MaxLength 320
$grantee = Get-AdminForgeInput $Inputs 'grantee' -Required -Pattern $upn -MaxLength 320
if ($owner -ieq $grantee) {
    throw (New-AdminForgeError -Category input -Message 'The owner already has access to their own OneDrive; pick someone else.')
}
$tenant = $Context['Tenant']
$tenantName = if ($tenant -is [System.Collections.IDictionary]) { [string]$tenant['SpoTenantName'] } else { '' }
if ($tenantName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
    throw (New-AdminForgeError -Category runner -Message 'The SharePoint tenant name is not configured (AF_SPO_TENANT_NAME).')
}

Write-AdminForgeProgress -Percent 10 -Message 'Finding the OneDrive'
try {
    $userProfile = Get-PnPUserProfileProperty -Account $owner | Select-Object PersonalUrl
} catch {
    throw (New-AdminForgeError -Category input -Message "Could not read the user profile of '$owner': $($_.Exception.Message)")
}
$url = ([string]$userProfile.PersonalUrl).TrimEnd('/')
if (-not $url) {
    throw (New-AdminForgeError -Category input -Message "$owner has no OneDrive (it was never opened, or it has been deleted).")
}
$expected = "^https://$([regex]::Escape($tenantName.ToLowerInvariant()))-my\.sharepoint\.(com|us|cn)/personal/[a-z0-9_-]+$"
if ($url.ToLowerInvariant() -notmatch $expected) {
    throw (New-AdminForgeError -Category script -Message "The profile of $owner points at '$url', which is not a OneDrive site of this tenant; nothing was changed.")
}

Write-AdminForgeProgress -Percent 50 -Message 'Adding the site collection administrator'
Write-AdminForgeLog "Adding $grantee as a site collection administrator of $url"
Set-PnPTenantSite -Identity $url -Owners @($grantee)

$result = [ordered]@{
    owner       = $owner
    grantee     = $grantee
    oneDriveUrl = $url
    granted     = $true
    verified    = $null
    note        = 'Added as an additional site collection administrator; existing administrators keep their access. Remove it in the SharePoint admin centre (Active sites › OneDrive › Permissions) when it is no longer needed.'
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
