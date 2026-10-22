<#
.SYNOPSIS
    SharePoint Online sharing posture: tenant sharing settings and per-site sharing capability.

.DESCRIPTION
    Reads tenant-level sharing settings (Get-PnPTenant) and every site's SharingCapability (Get-PnPTenantSite), with
    the engineer's own delegated SharePoint admin token. Site settings only: no files or sharing links are read.

.PARAMETER Inputs
    includeOneDrive   bool    Include OneDrive personal sites (default false).
    template          string  Only sites with this template, e.g. GROUP#0, SITEPAGEPUBLISHING#0, STS#3.
    includeSites      bool    Include the per-site rows (default true).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant (SpoTenantName required), Services, User.

.OUTPUTS
    Several output events, so tens of thousands of sites stay under the runner's line limit:
    1. @{ tenant = @{ sharingCapability; oneDriveSharingCapability; defaultSharingLinkType; defaultLinkPermission;
                      requireAnonymousLinksExpireInDays; sharingDomainRestrictionMode; preventExternalUsersFromResharing };
          summary = @{ total; bySharingCapability = @(@{ sharingCapability; count }); anyoneLinks; guests; internal } }
    2…n (when includeSites) @{ sites = @(@{ url; title; template; owner; groupId; sharingCapability; lastContentModified;
                                         storageUsedInBytes; lockState }) } — at most 2,000 sites each, in SharePoint's order.
    title is the URL when the site has none (the OneDrive host, the search centre). owner is the owner's email or
    sign-in name when the site list returns it (it doesn't for group-connected sites, whose owners are the group's
    owners); groupId is the Microsoft 365 group of a group-connected site, else null. Everything per site is shaped
    here, so the page's transform only filters and labels natively.

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
$sites = [System.Collections.Generic.List[object]]::new($raw.Count)
foreach ($site in $raw) {
    $groupId = [string]$site.GroupId
    $sites.Add([ordered]@{
            url                 = [string]$site.Url
            title               = if ($site.Title) { [string]$site.Title } else { [string]$site.Url }
            template            = [string]$site.Template
            owner               = if ($site.OwnerEmail) { [string]$site.OwnerEmail } else { [string]$site.Owner }
            groupId             = if ($groupId -and $groupId -ne $noGroup) { $groupId } else { $null }
            sharingCapability   = [string]$site.SharingCapability
            lastContentModified = if ($site.LastContentModifiedDate) { ([datetime]$site.LastContentModifiedDate).ToUniversalTime().ToString('o') } else { $null }
            storageUsedInBytes  = if ($site.StorageUsageCurrent) { [long]$site.StorageUsageCurrent * 1048576 } else { [long]0 }
            lockState           = [string]$site.LockState
        })
}

$raw = $null  # free the PnP objects before the sites are serialised (100,000+ sites)

$byLevel = @{}
foreach ($site in $sites) { $byLevel[$site.sharingCapability] = 1 + [int]$byLevel[$site.sharingCapability] }
Write-AdminForgeOutput -Data ([ordered]@{
        tenant  = $tenant
        summary = [ordered]@{
            total               = $sites.Count
            bySharingCapability = @($byLevel.Keys | Sort-Object | ForEach-Object { [ordered]@{ sharingCapability = [string]$_; count = $byLevel[$_] } })
            anyoneLinks         = [int]$byLevel['ExternalUserAndGuestSharing']
            guests              = [int]$byLevel['ExternalUserSharingOnly']
            internal            = [int]$byLevel['Disabled']
        }
    })

# The sites in chunks: one output event each, far below the runner's 8 MB line limit.
if ($includeSites) {
    $chunk = 2000
    for ($i = 0; $i -lt $sites.Count; $i += $chunk) {
        Write-AdminForgeProgress -Percent (60 + [int](39 * $i / [math]::Max(1, $sites.Count))) -Message "Sending sites $($i + 1) to $([math]::Min($i + $chunk, $sites.Count))"
        Write-AdminForgeOutput -Data ([ordered]@{ sites = @($sites.GetRange($i, [math]::Min($chunk, $sites.Count - $i))) })
    }
}

Write-AdminForgeProgress -Percent 100 -Message 'Done'
