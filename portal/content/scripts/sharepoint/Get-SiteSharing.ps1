<#
.SYNOPSIS
    SharePoint Online sharing posture: tenant sharing settings and per-site sharing capability.

.DESCRIPTION
    Reads tenant-level sharing settings (Get-PnPTenant) and every site's SharingCapability
    (Get-PnPTenantSite). Flags sites that allow "Anyone" links and sites whose sharing is more permissive
    than the tenant default would suggest for their template.

.PARAMETER Inputs
    includeOneDrive   bool    Include OneDrive personal sites (default false).
    template          string  Only sites with this template, e.g. GROUP#0, SITEPAGEPUBLISHING#0, STS#3.
    includeSites      bool    Include the per-site rows (default true).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant (SpoTenantName required), Services, User.

.OUTPUTS
    @{ tenant = @{ sharingCapability; oneDriveSharingCapability; defaultSharingLinkType; defaultLinkPermission;
                   requireAnonymousLinksExpireInDays; sharingDomainRestrictionMode; preventExternalUsersFromResharing };
       summary = @{ total; bySharingCapability = @(@{ sharingCapability; count }); anyoneLinks };
       sites = @(@{ url; title; template; owner; groupId; sharingCapability; lastContentModified; storageUsedMB;
                    lockState }) }
    owner is the owner's email or sign-in name when the site list returns it (it doesn't for group-connected sites,
    whose owners are the group's owners); groupId is the Microsoft 365 group of a group-connected site, else null.

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

$includeOneDrive = Get-AdminForgeInput $Inputs 'includeOneDrive' -Type Bool -Default $false
$template = Get-AdminForgeInput $Inputs 'template' -Pattern '^[A-Za-z0-9_]+#\d+$' -MaxLength 64
$includeSites = Get-AdminForgeInput $Inputs 'includeSites' -Type Bool -Default $true

Write-AdminForgeProgress -Percent 5 -Message 'Reading tenant sharing settings'
$t = Get-PnPTenant | Select-Object SharingCapability, OneDriveSharingCapability, DefaultSharingLinkType, DefaultLinkPermission,
    RequireAnonymousLinksExpireInDays, SharingDomainRestrictionMode, PreventExternalUsersFromResharing
$tenant = [ordered]@{
    sharingCapability                 = [string]$t.SharingCapability
    oneDriveSharingCapability         = [string]$t.OneDriveSharingCapability
    defaultSharingLinkType            = [string]$t.DefaultSharingLinkType
    defaultLinkPermission             = [string]$t.DefaultLinkPermission
    requireAnonymousLinksExpireInDays = $t.RequireAnonymousLinksExpireInDays
    sharingDomainRestrictionMode      = [string]$t.SharingDomainRestrictionMode
    preventExternalUsersFromResharing = [bool]$t.PreventExternalUsersFromResharing
}

Write-AdminForgeProgress -Percent 25 -Message 'Reading sites'
$params = @{}
if ($includeOneDrive) { $params.IncludeOneDriveSites = $true }
if ($template) { $params.Template = $template }
$raw = @(Get-PnPTenantSite @params | Select-Object Url, Title, Template, Owner, OwnerEmail, GroupId, SharingCapability,
        LastContentModifiedDate, StorageUsageCurrent, LockState)
Write-AdminForgeLog "Read $($raw.Count) sites"

$noGroup = '00000000-0000-0000-0000-000000000000'
$sites = @($raw | ForEach-Object {
        $groupId = [string]$_.GroupId
        [ordered]@{
            url                 = [string]$_.Url
            title               = [string]$_.Title
            template            = [string]$_.Template
            owner               = if ($_.OwnerEmail) { [string]$_.OwnerEmail } else { [string]$_.Owner }
            groupId             = if ($groupId -and $groupId -ne $noGroup) { $groupId } else { $null }
            sharingCapability   = [string]$_.SharingCapability
            lastContentModified = if ($_.LastContentModifiedDate) { ([datetime]$_.LastContentModifiedDate).ToUniversalTime().ToString('o') } else { $null }
            storageUsedMB       = $_.StorageUsageCurrent
            lockState           = [string]$_.LockState
        }
    })

$result = [ordered]@{
    tenant  = $tenant
    summary = [ordered]@{
        total               = $sites.Count
        bySharingCapability = @($sites | Group-Object { $_.sharingCapability } | ForEach-Object { [ordered]@{ sharingCapability = [string]$_.Name; count = $_.Count } })
        anyoneLinks         = @($sites | Where-Object { $_.sharingCapability -eq 'ExternalUserAndGuestSharing' }).Count
    }
}
if ($includeSites) { $result.sites = $sites }

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
