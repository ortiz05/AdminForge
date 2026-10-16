<#
.SYNOPSIS
    Finds one person's OneDrive: its URL from their user profile, and whether that site exists.

.DESCRIPTION
    Reads the owner's user profile (Get-PnPUserProfileProperty → PersonalUrl), checks that the URL is a OneDrive site
    of this tenant (https://<tenant>-my.sharepoint.<cloud>/personal/<name>), then reads the site through the
    SharePoint admin centre (Get-PnPTenantSite -Identity) — no access to the OneDrive itself is needed. A person
    without a OneDrive (never opened, not licensed) gets oneDriveUrl = null; one whose OneDrive was deleted gets
    exists = false. Any other failure to read the site fails the script with the reason.

.PARAMETER Inputs
    owner   string  Required. UPN of the person whose OneDrive is wanted.

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant (SpoTenantName required), Services, User.

.OUTPUTS
    @{ owner; oneDriveUrl; exists; lockState; storageUsedMB; lastContentModified }

.NOTES
    Tokens: sharepointAdmin. Mode: read. Role: SharePoint Administrator.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$owner = Get-AdminForgeInput $Inputs 'owner' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320
$tenant = $Context['Tenant']
$tenantName = if ($tenant -is [System.Collections.IDictionary]) { [string]$tenant['SpoTenantName'] } else { '' }
if ($tenantName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
    throw (New-AdminForgeError -Category runner -Message 'The SharePoint tenant name is not configured (AF_SPO_TENANT_NAME).')
}

Write-AdminForgeProgress -Percent 10 -Message 'Reading the user profile'
try {
    $userProfile = Get-PnPUserProfileProperty -Account $owner | Select-Object PersonalUrl
} catch {
    throw (New-AdminForgeError -Category input -Message "Could not read the user profile of '$owner': $($_.Exception.Message)")
}
$url = if ($userProfile) { ([string]$userProfile.PersonalUrl).TrimEnd('/') } else { '' }

$result = [ordered]@{
    owner               = $owner
    oneDriveUrl         = $null
    exists              = $false
    lockState           = $null
    storageUsedMB       = $null
    lastContentModified = $null
}
if ($url) {
    $expected = "^https://$([regex]::Escape($tenantName.ToLowerInvariant()))-my\.sharepoint\.(com|us|cn)/personal/[a-z0-9_-]+$"
    if ($url.ToLowerInvariant() -notmatch $expected) {
        throw (New-AdminForgeError -Category script -Message "The profile of $owner points at '$url', which is not a OneDrive site of this tenant.")
    }
    $result.oneDriveUrl = $url
    Write-AdminForgeProgress -Percent 50 -Message 'Reading the OneDrive site'
    $site = $null
    try {
        $site = Get-PnPTenantSite -Identity $url | Select-Object Url, LockState, StorageUsageCurrent, LastContentModifiedDate
    } catch {
        # Only "no such site" means the OneDrive is gone; throttling, permissions or outages fail with the reason.
        if ($_.Exception.Message -notmatch '(?i)cannot get site|not found|does not exist|404') {
            throw (New-AdminForgeError -Category script -Message "The OneDrive of $owner could not be read: $($_.Exception.Message)")
        }
        Write-AdminForgeLog -Level Warn "The OneDrive in the profile of $owner no longer exists: $($_.Exception.Message)"
    }
    if ($site) {
        $result.exists = $true
        $result.lockState = [string]$site.LockState
        $result.storageUsedMB = $site.StorageUsageCurrent
        $result.lastContentModified = if ($site.LastContentModifiedDate) { ([datetime]$site.LastContentModifiedDate).ToUniversalTime().ToString('o') } else { $null }
    }
}

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
