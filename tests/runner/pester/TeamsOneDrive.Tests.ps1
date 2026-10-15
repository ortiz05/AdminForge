#Requires -Version 7.4
# Teams user policies (portal/content/scripts/teams) and OneDrive access (portal/content/scripts/sharepoint).
# MicrosoftTeams and PnP cmdlets are global stubs returning synthetic data.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')
    $script:StubNames = @('Get-CsOnlineUser', 'Get-CsUserPolicyAssignment', 'Get-PnPUserProfileProperty', 'Set-PnPTenantSite')

    New-Stub 'Get-CsOnlineUser' {
        param($Identity)
        if ($Identity -ne 'adele@example.com' -and $Identity -ne 'lee@example.com') { throw "Management object not found for identity '$Identity'." }
        [pscustomobject]@{
            DisplayName = if ($Identity -like 'adele*') { 'Adele Vance' } else { 'Lee Gu' }
            UserPrincipalName = $Identity; AccountEnabled = $true; InterpretedUserType = 'PureOnlineTeamsOnlyUser'
            TeamsUpgradeEffectiveMode = 'TeamsOnly'; UsageLocation = 'GB'
            TeamsMessagingPolicy = $null
            TeamsMeetingPolicy = 'Tag:RestrictedAnonymousAccess'
            TeamsCallingPolicy = [pscustomobject]@{ Name = 'AllowCalling'; Authority = 'Tenant' }
            TeamsAppSetupPolicy = $null
            TenantDialPlan = 'UK-Dial'
        }
    }
    New-Stub 'Get-CsUserPolicyAssignment' {
        param($Identity)
        if ($Identity -eq 'lee@example.com') { throw 'The group policy assignment service is unavailable.' }
        @(
            [pscustomobject]@{ PolicyType = 'TeamsMessagingPolicy'; PolicyName = 'Restricted chat'; PolicySource = @(
                    [pscustomobject]@{ AssignmentType = 'Group'; PolicyName = 'Default chat'; Reference = '10000000-0000-4000-8000-000000000302'; Priority = 2 }
                    [pscustomobject]@{ AssignmentType = 'Group'; PolicyName = 'Restricted chat'; Reference = '10000000-0000-4000-8000-000000000301'; Priority = 1 }
                )
            }
            [pscustomobject]@{ PolicyType = 'TeamsMeetingPolicy'; PolicyName = 'RestrictedAnonymousAccess'; PolicySource = @(
                    [pscustomobject]@{ AssignmentType = 'Direct'; PolicyName = 'RestrictedAnonymousAccess'; Reference = $null; Priority = $null }
                    [pscustomobject]@{ AssignmentType = 'Group'; PolicyName = 'Kiosk'; Reference = '10000000-0000-4000-8000-000000000303'; Priority = 1 }
                )
            }
        )
    }
    New-Stub 'Get-PnPUserProfileProperty' {
        param($Account)
        switch ($Account) {
            'adele@example.com' { [pscustomobject]@{ PersonalUrl = 'https://example-my.sharepoint.com/personal/adele_example_com/' } }
            'nodrive@example.com' { [pscustomobject]@{ PersonalUrl = '' } }
            'odd@example.com' { [pscustomobject]@{ PersonalUrl = 'https://fabrikam-my.sharepoint.com/personal/odd_example_com/' } }
            default { throw "User profile for '$Account' not found." }
        }
    }
    New-Stub 'Set-PnPTenantSite' {
        param($Identity, $Owners)
        $global:AfOd.Calls.Add("Set-PnPTenantSite $Identity $($Owners -join ',')")
    }
}

AfterAll {
    Remove-Stubs $StubNames
    Remove-Variable -Name AfOd -Scope Global -ErrorAction SilentlyContinue
}

Describe 'teams/Get-UserTeamsPolicies.ps1' {
    It 'shows each policy with where it comes from: direct, group (by priority) or the org-wide default' {
        $r = Invoke-ContentScript 'teams/Get-UserTeamsPolicies.ps1' @{ identity = 'adele@example.com' }
        $r.Failure | Should -BeNullOrEmpty
        $o = $r.Output[0]
        $o.user.displayName | Should -Be 'Adele Vance'
        $o.user.teamsUpgradeEffectiveMode | Should -Be 'TeamsOnly'
        $by = @{}; foreach ($p in $o.policies) { $by[$p.policyType] = $p }
        $by['TeamsMessagingPolicy'].policyName | Should -Be 'Restricted chat'
        $by['TeamsMessagingPolicy'].assignment | Should -Be 'Group'
        $by['TeamsMessagingPolicy'].groupId | Should -Be '10000000-0000-4000-8000-000000000301'
        $by['TeamsMessagingPolicy'].priority | Should -Be 1
        $by['TeamsMeetingPolicy'].assignment | Should -Be 'Direct'
        $by['TeamsMeetingPolicy'].groupId | Should -BeNullOrEmpty
        $by['TeamsCallingPolicy'].policyName | Should -Be 'AllowCalling'
        $by['TeamsCallingPolicy'].assignment | Should -Be 'Direct'
        $by['TeamsAppSetupPolicy'].policyName | Should -Be 'Global'
        $by['TeamsAppSetupPolicy'].assignment | Should -Be 'Default'
        $by['TenantDialPlan'].policyName | Should -Be 'UK-Dial'
        ($o.policies | Select-Object -First 4 | ForEach-Object { $_.label }) | Should -Be @('Messaging', 'Meetings', 'Calling', 'App setup')
        $o.summary.group | Should -Be 1
        $o.summary.direct | Should -Be 3
        $o.summary.default | Should -Be (@($o.policies).Count - 4)
    }

    It 'falls back to direct assignments when group assignments cannot be read' {
        $r = Invoke-ContentScript 'teams/Get-UserTeamsPolicies.ps1' @{ identity = 'lee@example.com' }
        $r.Failure | Should -BeNullOrEmpty
        @($r.Events | Where-Object { $_.type -eq 'log' -and $_.level -eq 'warn' }).Count | Should -Be 1
        $meeting = $r.Output[0].policies | Where-Object { $_.policyType -eq 'TeamsMeetingPolicy' }
        $meeting.policyName | Should -Be 'RestrictedAnonymousAccess'
        $meeting.assignment | Should -Be 'Direct'
    }

    It 'reports an unknown user or a malformed name as an input error' {
        (Invoke-ContentScript 'teams/Get-UserTeamsPolicies.ps1' @{ identity = 'ghost@example.com' }).Category | Should -Be 'input'
        (Invoke-ContentScript 'teams/Get-UserTeamsPolicies.ps1' @{ identity = 'adele' }).Category | Should -Be 'input'
    }
}

Describe 'sharepoint/Grant-OneDriveAccess.ps1' {
    BeforeEach { $global:AfOd = @{ Calls = [System.Collections.Generic.List[string]]::new() } }

    It 'refuses to run in read mode' {
        (Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'adele@example.com'; grantee = 'lee@example.com' } 'read').Category | Should -Be 'readOnly'
        $global:AfOd.Calls | Should -BeNullOrEmpty
    }

    It "adds the grantee as a site collection administrator of the owner's OneDrive" {
        $r = Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'adele@example.com'; grantee = 'lee@example.com' } 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].oneDriveUrl | Should -Be 'https://example-my.sharepoint.com/personal/adele_example_com'
        $r.Output[0].granted | Should -BeTrue
        $global:AfOd.Calls | Should -Be @('Set-PnPTenantSite https://example-my.sharepoint.com/personal/adele_example_com lee@example.com')
    }

    It 'changes nothing when the OneDrive is missing or belongs to another tenant' {
        (Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'nodrive@example.com'; grantee = 'lee@example.com' } 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'ghost@example.com'; grantee = 'lee@example.com' } 'write').Category | Should -Be 'input'
        $odd = Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'odd@example.com'; grantee = 'lee@example.com' } 'write'
        $odd.Category | Should -Be 'script'
        $odd.Failure.Exception.Message | Should -Match 'not a OneDrive site of this tenant'
        $global:AfOd.Calls | Should -BeNullOrEmpty
    }

    It 'validates its inputs and needs the SharePoint tenant name' {
        (Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'adele@example.com'; grantee = 'ADELE@example.com' } 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'adele@example.com' } 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'sharepoint/Grant-OneDriveAccess.ps1' @{ owner = 'adele@example.com'; grantee = 'lee@example.com' } 'write' @{ Id = 'x'; Domain = 'example.com'; SpoTenantName = $null }).Category | Should -Be 'runner'
        $global:AfOd.Calls | Should -BeNullOrEmpty
    }
}
