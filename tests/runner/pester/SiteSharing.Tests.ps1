#Requires -Version 7.4
# sharepoint/Get-SiteSharing.ps1: the site list as SharePoint returns it — group-connected sites have no owner but a
# GroupId, other sites an owner email, sites without a group the empty GUID. PnP cmdlets are global stubs.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')
    $script:StubNames = @('Get-PnPTenant', 'Get-PnPTenantSite')
    New-Stub 'Get-PnPTenant' {
        [pscustomobject]@{ SharingCapability = 'ExternalUserAndGuestSharing'; OneDriveSharingCapability = 'ExternalUserAndGuestSharing'; DefaultSharingLinkType = 'AnonymousAccess'; DefaultLinkPermission = 'None'; RequireAnonymousLinksExpireInDays = -1; SharingDomainRestrictionMode = 'None'; PreventExternalUsersFromResharing = $false }
    }
    $script:ThreeSites = {
        param([switch]$IncludeOneDriveSites, $Template)
        @(
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/sites/ProjectAtlas'; Title = 'Project Atlas'; Template = 'GROUP#0'; Owner = ''; OwnerEmail = ''; GroupId = [guid]'10000000-0000-4000-8000-000000000201'; SharingCapability = 'ExternalUserSharingOnly'; LastContentModifiedDate = [datetime]'2026-10-01T00:00:00Z'; StorageUsageCurrent = 3; LockState = 'Unlock' }
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/sites/intranet'; Title = 'Intranet'; Template = 'SitePagePublishing#0'; Owner = 'i:0#.f|membership|leah@example.com'; OwnerEmail = 'leah@example.com'; GroupId = [guid]::Empty; SharingCapability = 'ExternalUserAndGuestSharing'; LastContentModifiedDate = [datetime]'2026-09-01T00:00:00Z'; StorageUsageCurrent = 1; LockState = 'Unlock' }
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/search'; Title = ''; Template = 'SRCHCEN#0'; Owner = 'admin@example.com'; OwnerEmail = $null; GroupId = [guid]::Empty; SharingCapability = 'Disabled'; LastContentModifiedDate = $null; StorageUsageCurrent = 1; LockState = 'Unlock' }
        )
    }
    New-Stub 'Get-PnPTenantSite' $script:ThreeSites
}

AfterAll { Remove-Stubs $StubNames }

Describe 'sharepoint/Get-SiteSharing.ps1' {
    It 'links group-connected sites to their group and takes the owner email, else the owner' {
        $r = Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1'
        $r.Failure | Should -BeNullOrEmpty
        $sites = $r.Output[1].sites
        $sites[0].groupId | Should -Be '10000000-0000-4000-8000-000000000201'
        $sites[0].owner | Should -Be ''
        $sites[1].groupId | Should -BeNullOrEmpty
        $sites[1].owner | Should -Be 'leah@example.com'
        $sites[2].owner | Should -Be 'admin@example.com'
        $r.Output[0].tenant.requireAnonymousLinksExpireInDays | Should -Be -1
    }

    It 'shapes each site where it is cheap: the URL as a missing title, storage in bytes' {
        $sites = (Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1').Output[1].sites
        $sites[2].title | Should -Be 'https://example.sharepoint.com/search'
        $sites[0].title | Should -Be 'Project Atlas'
        $sites[0].storageUsedInBytes | Should -Be (3 * 1048576)
    }

    It 'counts every sharing level in the first event' {
        $summary = (Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1').Output[0].summary
        $summary.total | Should -Be 3
        $summary.anyoneLinks | Should -Be 1
        $summary.guests | Should -Be 1
        $summary.internal | Should -Be 1
        @($summary.bySharingCapability).Count | Should -Be 3
    }

    It 'sends only the summary when the sites are not wanted' {
        $r = Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1' -Inputs @{ includeSites = $false }
        $r.Output.Count | Should -Be 1
        $r.Output[0].summary.total | Should -BeGreaterThan 0
    }

    Context 'at fleet size' {
        BeforeAll {
            New-Stub 'Get-PnPTenantSite' {
                param([switch]$IncludeOneDriveSites, $Template)
                foreach ($i in 1..4500) {
                    [pscustomobject]@{ Url = "https://example.sharepoint.com/sites/s$i"; Title = "Site $i"; Template = 'STS#3'; Owner = ''; OwnerEmail = 'owner@example.com'; GroupId = [guid]::Empty; SharingCapability = 'Disabled'; LastContentModifiedDate = $null; StorageUsageCurrent = 1; LockState = 'Unlock' }
                }
            }
        }
        AfterAll { New-Stub 'Get-PnPTenantSite' $script:ThreeSites }

        It 'sends thousands of sites in chunks of 2,000, under the runner line limit' {
            $r = Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1'
            $r.Failure | Should -BeNullOrEmpty
            $r.Output.Count | Should -Be 4
            $r.Output[0].summary.total | Should -Be 4500
            @($r.Output[1].sites).Count | Should -Be 2000
            @($r.Output[3].sites).Count | Should -Be 500
            $r.Output[3].sites[-1].url | Should -Be 'https://example.sharepoint.com/sites/s4500'
            ($r.Output[1] | ConvertTo-Json -Depth 8 -Compress).Length | Should -BeLessThan (8 * 1024 * 1024)
        }
    }
}
