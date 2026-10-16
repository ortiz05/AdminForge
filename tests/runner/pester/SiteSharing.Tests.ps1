#Requires -Version 7.4
# sharepoint/Get-SiteSharing.ps1: the site list as SharePoint returns it — group-connected sites have no owner but a
# GroupId, other sites an owner email, sites without a group the empty GUID. PnP cmdlets are global stubs.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')
    $script:StubNames = @('Get-PnPTenant', 'Get-PnPTenantSite')
    New-Stub 'Get-PnPTenant' {
        [pscustomobject]@{ SharingCapability = 'ExternalUserAndGuestSharing'; OneDriveSharingCapability = 'ExternalUserAndGuestSharing'; DefaultSharingLinkType = 'AnonymousAccess'; DefaultLinkPermission = 'None'; RequireAnonymousLinksExpireInDays = -1; SharingDomainRestrictionMode = 'None'; PreventExternalUsersFromResharing = $false }
    }
    New-Stub 'Get-PnPTenantSite' {
        param([switch]$IncludeOneDriveSites, $Template)
        @(
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/sites/ProjectAtlas'; Title = 'Project Atlas'; Template = 'GROUP#0'; Owner = ''; OwnerEmail = ''; GroupId = [guid]'10000000-0000-4000-8000-000000000201'; SharingCapability = 'ExternalUserSharingOnly'; LastContentModifiedDate = [datetime]'2026-10-01T00:00:00Z'; StorageUsageCurrent = 3; LockState = 'Unlock' }
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/sites/intranet'; Title = 'Intranet'; Template = 'SitePagePublishing#0'; Owner = 'i:0#.f|membership|leah@example.com'; OwnerEmail = 'leah@example.com'; GroupId = [guid]::Empty; SharingCapability = 'ExternalUserAndGuestSharing'; LastContentModifiedDate = [datetime]'2026-09-01T00:00:00Z'; StorageUsageCurrent = 1; LockState = 'Unlock' }
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/search'; Title = ''; Template = 'SRCHCEN#0'; Owner = 'admin@example.com'; OwnerEmail = $null; GroupId = [guid]::Empty; SharingCapability = 'Disabled'; LastContentModifiedDate = $null; StorageUsageCurrent = 1; LockState = 'Unlock' }
        )
    }
}

AfterAll { Remove-Stubs $StubNames }

Describe 'sharepoint/Get-SiteSharing.ps1' {
    It 'links group-connected sites to their group and takes the owner email, else the owner' {
        $r = Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1'
        $r.Failure | Should -BeNullOrEmpty
        $sites = $r.Output[0].sites
        $sites[0].groupId | Should -Be '10000000-0000-4000-8000-000000000201'
        $sites[0].owner | Should -Be ''
        $sites[1].groupId | Should -BeNullOrEmpty
        $sites[1].owner | Should -Be 'leah@example.com'
        $sites[2].owner | Should -Be 'admin@example.com'
        $sites[2].title | Should -Be ''
        $r.Output[0].tenant.requireAnonymousLinksExpireInDays | Should -Be -1
        $r.Output[0].summary.anyoneLinks | Should -Be 1
    }
}
