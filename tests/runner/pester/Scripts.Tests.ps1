#Requires -Version 7.4
# Contract and logic tests for portal/content/scripts. Exchange/Teams/SharePoint cmdlets are replaced by
# global stub functions returning synthetic data (example.com / fabrikam.example), so these run without a tenant.

BeforeAll {
    $script:Repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $script:ScriptsDir = Join-Path $Repo 'portal/content/scripts'
    Import-Module (Join-Path $Repo 'portal/apps/runner/ps/AdminForge.Runner/AdminForge.Runner.psd1') -Force

    # Runs a content script exactly as the worker does: text → scriptblock, merged streams → events.
    function Invoke-ContentScript([string]$RelativePath, [hashtable]$Inputs = @{}, [string]$Mode = 'read') {
        $events = [System.Collections.Generic.List[object]]::new()
        Set-AdminForgeEventSink -ScriptBlock { param($e) $events.Add($e) }.GetNewClosure()
        $context = @{
            JobId = 'pester'; Mode = $Mode; Services = @('Exchange')
            Tenant = @{ Id = '0f3a4c2e-8b1d-4e6f-9a7c-2d5b8e1f4a63'; Domain = 'example.onmicrosoft.com'; SpoTenantName = 'example' }
            User = @{ Upn = 'engineer@example.com'; ObjectId = $null }
        }
        $sb = [scriptblock]::Create((Get-Content -Raw -LiteralPath (Join-Path $ScriptsDir $RelativePath)))
        $failure = $null
        try {
            & $sb -Inputs $Inputs -Context $context *>&1 | Send-AdminForgeStreamRecord
        } catch {
            $failure = $_
        } finally {
            Set-AdminForgeEventSink -Reset
        }
        [pscustomobject]@{
            Events   = $events.ToArray()
            Output   = @($events | Where-Object { $_.type -eq 'output' } | ForEach-Object { $_.data })
            Failure  = $failure
            Category = if ($failure) { Get-AdminForgeErrorCategory $failure } else { $null }
        }
    }

    function New-Stub([string]$Name, [scriptblock]$Body) { Set-Item -Path "function:global:$Name" -Value $Body }

    $script:StubNames = @(
        'Get-EXOMailbox', 'Get-EXORecipient', 'Get-AcceptedDomain', 'Get-InboxRule', 'Set-Mailbox',
        'Get-DistributionGroup', 'Get-DistributionGroupMember', 'Add-DistributionGroupMember', 'Remove-DistributionGroupMember',
        'Get-Team', 'Get-TeamUser', 'Get-PnPTenant', 'Get-PnPTenantSite'
    )
    $global:AfStub = @{}

    New-Stub 'Get-AcceptedDomain' { @([pscustomobject]@{ DomainName = 'example.com' }, [pscustomobject]@{ DomainName = 'example.onmicrosoft.com' }) }
    New-Stub 'Get-EXOMailbox' {
        param($ResultSize, $RecipientTypeDetails, $Properties, $Filter, $Identity)
        if ($Identity) {
            if (-not $global:AfStub.Mailboxes.Contains($Identity)) { throw "Couldn't find object '$Identity'" }
            return $global:AfStub.Mailboxes[$Identity]
        }
        $all = @($global:AfStub.Mailboxes.Values)
        if ($Filter) { $all = @($all | Where-Object { $_.ForwardingSmtpAddress -or $_.ForwardingAddress }) }
        if ($RecipientTypeDetails) { $all = @($all | Where-Object { $_.RecipientTypeDetails -in $RecipientTypeDetails }) }
        if ($ResultSize -and $ResultSize -ne 'Unlimited') { $all = @($all | Select-Object -First ([int]$ResultSize)) }
        $all
    }
    New-Stub 'Get-EXORecipient' { param($Identity, $Properties) [pscustomobject]@{ PrimarySmtpAddress = $null; ExternalEmailAddress = 'SMTP:partner@fabrikam.example' } }
    New-Stub 'Get-InboxRule' {
        param($Mailbox)
        if ($Mailbox -eq 'alex@example.com') {
            [pscustomobject]@{ Name = 'Send to home'; Enabled = $true; ForwardTo = @('"Alex Home" [SMTP:alex@fabrikam.example]'); ForwardAsAttachmentTo = $null; RedirectTo = $null }
        }
    }
    New-Stub 'Set-Mailbox' {
        param($Identity, $Type)
        $global:AfStub.SetMailboxCalls++
        $global:AfStub.Mailboxes[$Identity].RecipientTypeDetails = "${Type}Mailbox"
    }
    New-Stub 'Get-DistributionGroup' {
        param($Identity, $ResultSize, $RecipientTypeDetails)
        $groups = @(
            [pscustomobject]@{ DisplayName = 'All Staff'; PrimarySmtpAddress = 'allstaff@example.com'; Alias = 'allstaff'; RecipientTypeDetails = 'MailUniversalDistributionGroup'; ManagedBy = @('Admin One'); MemberJoinRestriction = 'Closed'; MemberDepartRestriction = 'Closed'; RequireSenderAuthenticationEnabled = $true; HiddenFromAddressListsEnabled = $false; IsDirSynced = $false; WhenCreated = [datetime]'2026-01-02T03:04:05Z' }
            [pscustomobject]@{ DisplayName = 'Partners'; PrimarySmtpAddress = 'partners@example.com'; Alias = 'partners'; RecipientTypeDetails = 'MailUniversalSecurityGroup'; ManagedBy = @(); MemberJoinRestriction = 'Closed'; MemberDepartRestriction = 'Closed'; RequireSenderAuthenticationEnabled = $false; HiddenFromAddressListsEnabled = $true; IsDirSynced = $true; WhenCreated = $null }
        )
        if ($Identity) {
            $match = $groups | Where-Object PrimarySmtpAddress -EQ $Identity
            if (-not $match) { throw "Couldn't find object '$Identity'" }
            return $match
        }
        $groups | Where-Object { -not $RecipientTypeDetails -or $_.RecipientTypeDetails -in $RecipientTypeDetails }
    }
    New-Stub 'Get-DistributionGroupMember' { param($Identity, $ResultSize) @($global:AfStub.Members | ForEach-Object { [pscustomobject]@{ PrimarySmtpAddress = $_ } }) }
    New-Stub 'Add-DistributionGroupMember' {
        param($Identity, $Member, [switch]$Confirm, [switch]$BypassSecurityGroupManagerCheck)
        if ($Member -like 'broken@*') { throw "Couldn't find object '$Member'" }
        $global:AfStub.Members.Add($Member)
    }
    New-Stub 'Remove-DistributionGroupMember' { param($Identity, $Member, [switch]$Confirm, [switch]$BypassSecurityGroupManagerCheck) [void]$global:AfStub.Members.Remove($Member) }
    New-Stub 'Get-Team' {
        @(
            [pscustomobject]@{ GroupId = 'b1f6c0de-0000-4000-8000-000000000001'; DisplayName = 'Project A'; Visibility = 'Private'; Archived = $false; MailNickName = 'projecta' }
            [pscustomobject]@{ GroupId = 'b1f6c0de-0000-4000-8000-000000000002'; DisplayName = 'Old Team'; Visibility = 'Public'; Archived = $true; MailNickName = 'oldteam' }
        )
    }
    New-Stub 'Get-TeamUser' { param($GroupId, $Role) if ($GroupId -like '*1') { [pscustomobject]@{ User = 'owner@example.com' } } }
    New-Stub 'Get-PnPTenant' { [pscustomobject]@{ SharingCapability = 'ExternalUserSharingOnly'; OneDriveSharingCapability = 'ExistingExternalUserSharingOnly'; DefaultSharingLinkType = 'Internal'; DefaultLinkPermission = 'View'; RequireAnonymousLinksExpireInDays = 30; SharingDomainRestrictionMode = 'None'; PreventExternalUsersFromResharing = $true } }
    New-Stub 'Get-PnPTenantSite' {
        param([switch]$IncludeOneDriveSites, $Template)
        @(
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/sites/hr'; Title = 'HR'; Template = 'GROUP#0'; Owner = 'hr@example.com'; SharingCapability = 'Disabled'; LastContentModifiedDate = [datetime]'2026-09-01T00:00:00Z'; StorageUsageCurrent = 120; LockState = 'Unlock' }
            [pscustomobject]@{ Url = 'https://example.sharepoint.com/sites/marketing'; Title = 'Marketing'; Template = 'SITEPAGEPUBLISHING#0'; Owner = 'mkt@example.com'; SharingCapability = 'ExternalUserAndGuestSharing'; LastContentModifiedDate = $null; StorageUsageCurrent = 5; LockState = 'Unlock' }
        ) | Where-Object { -not $Template -or $_.Template -eq $Template }
    }
}

AfterAll {
    foreach ($name in $StubNames) { Remove-Item -Path "function:global:$name" -ErrorAction SilentlyContinue }
    Remove-Variable -Name AfStub -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Content scripts' {
    BeforeEach {
        $global:AfStub = @{
            SetMailboxCalls = 0
            Members         = [System.Collections.Generic.List[string]]::new([string[]]@('kim@example.com', 'lee@example.com'))
            Mailboxes       = [ordered]@{
                'alex@example.com'   = [pscustomobject]@{ DisplayName = 'Alex'; UserPrincipalName = 'alex@example.com'; PrimarySmtpAddress = 'alex@example.com'; RecipientTypeDetails = 'UserMailbox'; ExternalDirectoryObjectId = 'a1'; WhenCreated = [datetime]'2026-02-03T04:05:06Z'; HiddenFromAddressListsEnabled = $false; LitigationHoldEnabled = $true; ArchiveStatus = 'Active'; ForwardingSmtpAddress = 'smtp:alex.personal@fabrikam.example'; ForwardingAddress = $null; DeliverToMailboxAndForward = $true }
                'sales@example.com'  = [pscustomobject]@{ DisplayName = 'Sales'; UserPrincipalName = 'sales@example.com'; PrimarySmtpAddress = 'sales@example.com'; RecipientTypeDetails = 'SharedMailbox'; ExternalDirectoryObjectId = 's1'; WhenCreated = $null; HiddenFromAddressListsEnabled = $true; LitigationHoldEnabled = $false; ArchiveStatus = 'None'; ForwardingSmtpAddress = $null; ForwardingAddress = 'Partner Contact'; DeliverToMailboxAndForward = $false }
                'room1@example.com'  = [pscustomobject]@{ DisplayName = 'Room 1'; UserPrincipalName = 'room1@example.com'; PrimarySmtpAddress = 'room1@example.com'; RecipientTypeDetails = 'RoomMailbox'; ExternalDirectoryObjectId = 'r1'; WhenCreated = $null; HiddenFromAddressListsEnabled = $false; LitigationHoldEnabled = $false; ArchiveStatus = 'None'; ForwardingSmtpAddress = 'smtp:desk@example.com'; ForwardingAddress = $null; DeliverToMailboxAndForward = $false }
            }
        }
    }

    Describe 'Script contract' {
        BeforeDiscovery {
            $root = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/content/scripts')).Path
            $scripts = @(Get-ChildItem -Path $root -Filter *.ps1 -Recurse | ForEach-Object { @{ Name = $_.FullName.Substring($root.Length + 1); Path = $_.FullName } })
        }

        It '<Name> has help, [CmdletBinding()], the Inputs/Context contract, strict mode and no dynamic code' -ForEach $scripts {
            $tokens = $null; $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
            $errors | Should -BeNullOrEmpty
            $help = $ast.GetHelpContent()
            $help.Synopsis | Should -Not -BeNullOrEmpty
            $help.Parameters.Keys | Should -Contain 'INPUTS'
            $help.Notes | Should -Match 'Tokens:'
            @($ast.ParamBlock.Attributes.TypeName.Name) | Should -Contain 'CmdletBinding'
            $params = @{}
            foreach ($p in $ast.ParamBlock.Parameters) { $params[$p.Name.VariablePath.UserPath] = $p.StaticType.Name }
            $params['Inputs'] | Should -Be 'Hashtable'
            $params['Context'] | Should -Be 'Hashtable'
            $text = Get-Content -Raw -LiteralPath $Path
            $text | Should -Match 'Set-StrictMode -Version Latest'
            $text | Should -Not -Match '(?i)\b(Invoke-Expression|iex)\b|\[scriptblock\]::Create|NewScriptBlock'
        }
    }

    Describe 'Exchange read scripts' {
        It 'Get-MailboxSummary counts by type and flags' {
            $r = Invoke-ContentScript 'exchange/Get-MailboxSummary.ps1'
            $r.Failure | Should -BeNullOrEmpty
            $r.Output.Count | Should -Be 1
            $o = $r.Output[0]
            $o.total | Should -Be 3
            $o.litigationHold | Should -Be 1
            $o.archiveEnabled | Should -Be 1
            $o.hiddenFromAddressLists | Should -Be 1
            ($o.byType | ForEach-Object { "$($_.type)=$($_.count)" }) | Should -Contain 'SharedMailbox=1'
            $o.mailboxes[0].whenCreated | Should -Be '2026-02-03T04:05:06.0000000Z'
        }

        It 'Get-MailboxSummary validates its inputs' {
            $r = Invoke-ContentScript 'exchange/Get-MailboxSummary.ps1' @{ recipientTypeDetails = @('NotAType') }
            $r.Category | Should -Be 'input'
        }

        It 'Get-MailboxForwarding flags external forwarding, contacts and inbox rules' {
            $r = Invoke-ContentScript 'exchange/Get-MailboxForwarding.ps1' @{ includeInboxRules = $true }
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.summary.mailboxForwarding | Should -Be 3
            $o.summary.inboxRuleForwarding | Should -Be 1
            $o.summary.external | Should -Be 3
            $byTarget = @{}
            foreach ($f in $o.findings) { $byTarget[$f.target] = $f }
            $byTarget['alex.personal@fabrikam.example'].external | Should -BeTrue
            $byTarget['desk@example.com'].external | Should -BeFalse
            $byTarget['partner@fabrikam.example'].mailbox | Should -Be 'sales@example.com'
            ($o.findings | Where-Object source -EQ 'inboxRule').ruleName | Should -Be 'Send to home'
        }

        It 'Get-MailboxForwarding can return external findings only' {
            $r = Invoke-ContentScript 'exchange/Get-MailboxForwarding.ps1' @{ externalOnly = $true }
            @($r.Output[0].findings).Count | Should -Be 2
        }

        It 'Get-DistributionLists reports groups, owners and external senders' {
            $r = Invoke-ContentScript 'exchange/Get-DistributionLists.ps1' @{ includeMemberCounts = $true }
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.total | Should -Be 2
            $o.acceptExternalSenders | Should -Be 1
            $o.groups[0].managedBy | Should -Be @('Admin One')
            $o.groups[0].memberCount | Should -Be 2
        }
    }

    Describe 'Exchange write scripts' {
        It 'Convert-ToSharedMailbox refuses to run in read mode' {
            $r = Invoke-ContentScript 'exchange/Convert-ToSharedMailbox.ps1' @{ identity = 'alex@example.com' } 'read'
            $r.Category | Should -Be 'readOnly'
            $global:AfStub.SetMailboxCalls | Should -Be 0
        }

        It 'Convert-ToSharedMailbox converts a user mailbox and verifies it' {
            $r = Invoke-ContentScript 'exchange/Convert-ToSharedMailbox.ps1' @{ identity = 'alex@example.com' } 'write'
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.before | Should -Be 'UserMailbox'
            $o.after | Should -Be 'SharedMailbox'
            $o.changed | Should -BeTrue
            $o.verified | Should -BeTrue
            $global:AfStub.SetMailboxCalls | Should -Be 1
        }

        It 'Convert-ToSharedMailbox is idempotent for shared mailboxes' {
            $r = Invoke-ContentScript 'exchange/Convert-ToSharedMailbox.ps1' @{ identity = 'sales@example.com' } 'write'
            $r.Output[0].changed | Should -BeFalse
            $global:AfStub.SetMailboxCalls | Should -Be 0
        }

        It 'Convert-ToSharedMailbox rejects other mailbox types and bad identities' {
            (Invoke-ContentScript 'exchange/Convert-ToSharedMailbox.ps1' @{ identity = 'room1@example.com' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Convert-ToSharedMailbox.ps1' @{ identity = 'not an address' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Convert-ToSharedMailbox.ps1' @{ identity = 'ghost@example.com' } 'write').Category | Should -Be 'input'
        }

        It 'Set-DistributionListMembers adds and removes idempotently' {
            $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'allstaff@example.com'; add = @('new@example.com', 'KIM@example.com'); remove = @('lee@example.com', 'gone@example.com') } 'write'
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.added | Should -Be @('new@example.com')
            $o.removed | Should -Be @('lee@example.com')
            @($o.skipped).Count | Should -Be 2
            $o.memberCountBefore | Should -Be 2
            $o.memberCountAfter | Should -Be 2
            $global:AfStub.Members | Should -Contain 'new@example.com'
            $global:AfStub.Members | Should -Not -Contain 'lee@example.com'
        }

        It 'Set-DistributionListMembers reports partial failures and then fails the job' {
            $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'allstaff@example.com'; add = @('broken@example.com', 'ok@example.com') } 'write'
            $r.Output[0].added | Should -Be @('ok@example.com')
            $r.Output[0].failed[0].member | Should -Be 'broken@example.com'
            $r.Category | Should -Be 'script'
            $r.Failure.Exception.Message | Should -Match '1 of 2 membership changes failed'
        }

        It 'Set-DistributionListMembers validates its inputs' {
            (Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'allstaff@example.com' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'allstaff@example.com'; add = @('a@example.com'); remove = @('A@example.com') } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'allstaff@example.com'; add = @('not-an-address') } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'allstaff@example.com'; add = @('a@example.com') } 'read').Category | Should -Be 'readOnly'
        }
    }

    Describe 'Teams and SharePoint read scripts' {
        It 'Get-TeamsSummary reports visibility, archived and ownerless teams' {
            $r = Invoke-ContentScript 'teams/Get-TeamsSummary.ps1' @{ includeOwnerCounts = $true }
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.total | Should -Be 2
            $o.archived | Should -Be 1
            @($o.ownerless).Count | Should -Be 1
            $o.ownerless[0].displayName | Should -Be 'Old Team'
        }

        It 'Get-SiteSharing reports tenant settings and anyone-link sites' {
            $r = Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1'
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.tenant.sharingCapability | Should -Be 'ExternalUserSharingOnly'
            $o.summary.total | Should -Be 2
            $o.summary.anyoneLinks | Should -Be 1
            $o.sites[1].lastContentModified | Should -BeNullOrEmpty
        }

        It 'Get-SiteSharing filters by template and validates it' {
            (Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1' @{ template = 'GROUP#0' }).Output[0].summary.total | Should -Be 1
            (Invoke-ContentScript 'sharepoint/Get-SiteSharing.ps1' @{ template = "x'; Remove-Item /" }).Category | Should -Be 'input'
        }
    }

    Describe 'diagnostics/Test-Runner.ps1' {
        It 'echoes inputs and reports progress' {
            $r = Invoke-ContentScript 'diagnostics/Test-Runner.ps1' @{ message = 'hello'; steps = 4 }
            $r.Failure | Should -BeNullOrEmpty
            @($r.Events | Where-Object type -EQ 'progress').Count | Should -Be 4
            $r.Output[0].message | Should -Be 'hello'
            $r.Output[0].echo.steps | Should -Be 4
        }

        It 'fails on request with a script error' {
            (Invoke-ContentScript 'diagnostics/Test-Runner.ps1' @{ fail = $true }).Category | Should -Be 'script'
        }
    }
}
