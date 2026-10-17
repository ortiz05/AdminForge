#Requires -Version 7.4
# Creating shared mailboxes, room mailboxes and distribution lists, and removing ones AdminForge created
# (portal/content/scripts/exchange/{Get-RecipientAvailability,New-SharedMailbox,New-RoomMailbox,New-DistributionList,
# Remove-CreatedRecipient}.ps1). Exchange cmdlets are global stubs over an in-memory directory of recipients that
# behaves like Exchange where it matters: lookups fail with "couldn't find object" (or throttling for
# throttled@example.com, "matches multiple entries" for dup), new objects come back by Exchange id before their Entra
# account exists (AfRx.Pending), and only a list's owners may change or remove it unless the check is bypassed.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')

    $script:StubNames = @(
        'Get-AcceptedDomain', 'Get-EXORecipient', 'Get-EXOMailbox', 'New-Mailbox', 'Set-Mailbox', 'Get-EXOMailboxPermission',
        'Add-MailboxPermission', 'Get-EXORecipientPermission', 'Add-RecipientPermission', 'Set-CalendarProcessing',
        'Get-CalendarProcessing', 'New-DistributionGroup', 'Get-DistributionGroup', 'Set-DistributionGroup',
        'Get-DistributionGroupMember', 'Add-DistributionGroupMember', 'Remove-Mailbox', 'Remove-DistributionGroup', 'Start-Sleep'
    )
    $script:Mark = 'AdminForge-created by someone@example.com on 2026-10-01'
    $script:Avery = '10000000-0000-4000-8000-000000000001'
    $script:Blake = '10000000-0000-4000-8000-000000000002'
    $script:Dana = '10000000-0000-4000-8000-000000000004'
    # The engineer signs in as avery@example.onmicrosoft.com; their mailbox's address is avery@example.com.
    $script:Engineer = @{ Upn = 'avery@example.onmicrosoft.com'; ObjectId = $script:Avery }

    function script:Reset-Directory {
        $global:AfRx = @{
            Recipients    = [ordered]@{}
            FullAccess    = [System.Collections.Generic.List[object]]::new()
            SendAs        = [System.Collections.Generic.List[object]]::new()
            Calendar      = @{}
            Members       = @{}
            Calls         = [System.Collections.Generic.List[string]]::new()
            NextId        = 100
            Caller        = $script:Avery
            Pending       = @()
            FailGrant     = @()
            FailStepDown  = $false
        }
        foreach ($p in @(
                @{ Address = 'avery@example.com'; Type = 'UserMailbox'; Id = $script:Avery; Upn = 'avery@example.onmicrosoft.com' },
                @{ Address = 'blake@example.com'; Type = 'UserMailbox'; Id = $script:Blake },
                @{ Address = 'reception@example.com'; Type = 'SharedMailbox'; Id = '10000000-0000-4000-8000-000000000003' },
                @{ Address = 'dana@example.com'; Type = 'UserMailbox'; Id = $script:Dana },
                @{ Address = 'kim@partner.example'; Type = 'GuestMailUser'; Id = '10000000-0000-4000-8000-000000000005' },
                @{ Address = 'supplier@fabrikam.example'; Type = 'MailContact'; Id = '10000000-0000-4000-8000-000000000006' },
                # Someone set AdminForge's mark on a user mailbox (the mark is a guard rail, not a permission).
                @{ Address = 'ceo@example.com'; Type = 'UserMailbox'; Id = '10000000-0000-4000-8000-000000000007'; Mark = $script:Mark }
            )) {
            $alias = $p.Address.Split('@')[0]
            $global:AfRx.Recipients[$p.Address] = [pscustomobject]@{
                DisplayName = $alias; PrimarySmtpAddress = $p.Address; RecipientTypeDetails = $p.Type; Alias = $alias; Name = $alias
                ExternalDirectoryObjectId = $p.Id; Guid = [guid]::NewGuid().ToString(); UserPrincipalName = if ($p['Upn']) { $p['Upn'] } else { $p.Address }
                CustomAttribute15 = if ($p['Mark']) { $p['Mark'] } else { '' }; AccountDisabled = $false; ResourceCapacity = $null
                ManagedBy = @(); RequireSenderAuthenticationEnabled = $true
            }
        }
    }
    function script:Find-Rx([string]$Identity) {
        if ($Identity -eq 'throttled@example.com') { throw 'The request was throttled; try again later.' }
        if ($Identity -eq 'dup') { throw "The operation couldn't be performed because 'dup' matches multiple entries." }
        foreach ($r in $global:AfRx.Recipients.Values) {
            foreach ($v in @($r.PrimarySmtpAddress, $r.Alias, $r.Name, $r.ExternalDirectoryObjectId, $r.Guid, $r.UserPrincipalName)) {
                if ($v -and $v -ieq $Identity) { return $r }
            }
        }
        throw "Couldn't find object '$Identity'. Please make sure that it was spelled correctly or specify a different object."
    }
    $global:AfFindRx = ${function:script:Find-Rx}
    function script:Add-Rx([string]$Address, [string]$Alias, [string]$Name, [string]$Display, [string]$Type) {
        $global:AfRx.NextId++
        $global:AfRx.Recipients[$Address] = [pscustomobject]@{
            DisplayName = $Display; PrimarySmtpAddress = $Address; RecipientTypeDetails = $Type; Alias = $Alias; Name = $Name
            ExternalDirectoryObjectId = ('20000000-0000-4000-8000-{0:d12}' -f $global:AfRx.NextId); Guid = [guid]::NewGuid().ToString()
            UserPrincipalName = $Address; CustomAttribute15 = ''; AccountDisabled = $false; ResourceCapacity = $null; ManagedBy = @()
            RequireSenderAuthenticationEnabled = $true
        }
        $global:AfRx.Recipients[$Address]
    }
    $global:AfAddRx = ${function:script:Add-Rx}
    # Exchange: only a list's owners may change it, unless BypassSecurityGroupManagerCheck (Organization Management).
    $global:AfAssertOwner = {
        param($Group, [bool]$Bypass)
        if (-not $Bypass -and @($Group.ManagedBy) -notcontains $global:AfRx.Caller) {
            throw "You don't have sufficient permissions. This operation can only be performed by a manager of the group."
        }
    }

    New-Stub 'Start-Sleep' { param($Seconds, $Milliseconds) }
    New-Stub 'Get-AcceptedDomain' { @([pscustomobject]@{ DomainName = 'example.com' }, [pscustomobject]@{ DomainName = 'example.onmicrosoft.com' }) }
    New-Stub 'Get-EXORecipient' { param($Identity, $Properties) & $global:AfFindRx $Identity }
    New-Stub 'Get-EXOMailbox' {
        param($Identity, $Properties)
        $r = & $global:AfFindRx $Identity
        if ($r.RecipientTypeDetails -notlike '*Mailbox') { throw "Couldn't find object '$Identity'." }
        if ($global:AfRx.Pending -contains $r.PrimarySmtpAddress) {
            $copy = $r.PSObject.Copy(); $copy.ExternalDirectoryObjectId = ''; return $copy
        }
        $r
    }
    New-Stub 'New-Mailbox' {
        param([switch]$Shared, [switch]$Room, $Name, $DisplayName, $Alias, $PrimarySmtpAddress)
        $type = if ($Room) { 'RoomMailbox' } else { 'SharedMailbox' }
        $global:AfRx.Calls.Add("New-Mailbox $type $PrimarySmtpAddress name=$Name")
        $new = & $global:AfAddRx $PrimarySmtpAddress $Alias $Name $DisplayName $type
        # Exchange creates the accounts of shared and room mailboxes blocked.
        $new.AccountDisabled = $true
        $new
    }
    New-Stub 'Set-Mailbox' {
        param($Identity, $CustomAttribute15, $AccountDisabled, $ResourceCapacity)
        $r = & $global:AfFindRx $Identity
        $global:AfRx.Calls.Add("Set-Mailbox $Identity $(($PSBoundParameters.Keys | Where-Object { $_ -ne 'Identity' } | Sort-Object) -join ',')")
        foreach ($k in $PSBoundParameters.Keys) { if ($k -ne 'Identity') { $r.$k = $PSBoundParameters[$k] } }
    }
    New-Stub 'Get-EXOMailboxPermission' {
        param($Identity, $User)
        $r = & $global:AfFindRx $Identity
        $hits = @($global:AfRx.FullAccess | Where-Object { $_.Mailbox -eq $r.PrimarySmtpAddress -and $_.User -ieq $User })
        if (-not $hits.Count) { throw "No permissions were found for user '$User'." }
        $hits | ForEach-Object { [pscustomobject]$_ }
    }
    New-Stub 'Add-MailboxPermission' {
        param($Identity, $User, $AccessRights, $InheritanceType, $AutoMapping, [switch]$Confirm)
        if ($global:AfRx.FailGrant -contains $User) { throw "The server is busy; Full Access for $User wasn't saved." }
        $global:AfRx.Calls.Add("Add-MailboxPermission $Identity $User")
        $global:AfRx.FullAccess.Add(@{ Mailbox = $Identity; User = $User; AccessRights = @('FullAccess'); IsInherited = $false })
    }
    New-Stub 'Get-EXORecipientPermission' {
        param($Identity, $Trustee)
        @($global:AfRx.SendAs | Where-Object { $_.Mailbox -eq $Identity -and $_.Trustee -ieq $Trustee }) | ForEach-Object { [pscustomobject]$_ }
    }
    New-Stub 'Add-RecipientPermission' {
        param($Identity, $Trustee, $AccessRights, [switch]$Confirm)
        $global:AfRx.Calls.Add("Add-RecipientPermission $Identity $Trustee")
        $global:AfRx.SendAs.Add(@{ Mailbox = $Identity; Trustee = $Trustee; AccessRights = @('SendAs') })
    }
    New-Stub 'Set-CalendarProcessing' {
        param($Identity, $AutomateProcessing, $AllowConflicts, $BookingWindowInDays, $MaximumDurationInMinutes, [switch]$Confirm)
        $global:AfRx.Calls.Add("Set-CalendarProcessing $Identity $AutomateProcessing")
        $global:AfRx.Calendar[$Identity] = [pscustomobject]@{
            AutomateProcessing = $AutomateProcessing; AllowConflicts = $AllowConflicts
            BookingWindowInDays = $BookingWindowInDays; MaximumDurationInMinutes = $MaximumDurationInMinutes
        }
    }
    New-Stub 'Get-CalendarProcessing' { param($Identity) $global:AfRx.Calendar[$Identity] }
    New-Stub 'New-DistributionGroup' {
        param($Name, $DisplayName, $Alias, $PrimarySmtpAddress, $Type, $ManagedBy, $MemberJoinRestriction, $MemberDepartRestriction, $RequireSenderAuthenticationEnabled)
        $global:AfRx.Calls.Add("New-DistributionGroup $PrimarySmtpAddress name=$Name owners=$($ManagedBy -join ',')")
        $g = & $global:AfAddRx $PrimarySmtpAddress $Alias $Name $DisplayName 'MailUniversalDistributionGroup'
        $g.ManagedBy = @($ManagedBy | ForEach-Object { (& $global:AfFindRx $_).ExternalDirectoryObjectId })
        $g.RequireSenderAuthenticationEnabled = $RequireSenderAuthenticationEnabled
        $global:AfRx.Members[$PrimarySmtpAddress] = [System.Collections.Generic.List[string]]::new()
        $g
    }
    New-Stub 'Get-DistributionGroup' {
        param($Identity)
        $g = & $global:AfFindRx $Identity
        if ($g.RecipientTypeDetails -ne 'MailUniversalDistributionGroup') { throw "Couldn't find object '$Identity'." }
        if ($global:AfRx.Pending -contains $g.PrimarySmtpAddress) {
            $copy = $g.PSObject.Copy(); $copy.ExternalDirectoryObjectId = ''; return $copy
        }
        $g
    }
    New-Stub 'Set-DistributionGroup' {
        param($Identity, $CustomAttribute15, $RequireSenderAuthenticationEnabled, $ManagedBy, [switch]$BypassSecurityGroupManagerCheck)
        $g = & $global:AfFindRx $Identity
        & $global:AfAssertOwner $g ([bool]$BypassSecurityGroupManagerCheck)
        $global:AfRx.Calls.Add("Set-DistributionGroup $Identity $(($PSBoundParameters.Keys | Where-Object { $_ -ne 'Identity' } | Sort-Object) -join ',')")
        if ($PSBoundParameters.ContainsKey('CustomAttribute15')) { $g.CustomAttribute15 = $CustomAttribute15 }
        if ($PSBoundParameters.ContainsKey('RequireSenderAuthenticationEnabled')) { $g.RequireSenderAuthenticationEnabled = $RequireSenderAuthenticationEnabled }
        if ($ManagedBy -is [hashtable]) {
            if ($ManagedBy.ContainsKey('Add')) { $g.ManagedBy = @($g.ManagedBy) + @($ManagedBy.Add | ForEach-Object { (& $global:AfFindRx $_).ExternalDirectoryObjectId }) }
            if ($ManagedBy.ContainsKey('Remove')) {
                if ($global:AfRx.FailStepDown) { throw 'The group must have at least one owner who is a mailbox.' }
                $drop = @($ManagedBy.Remove | ForEach-Object { (& $global:AfFindRx $_).ExternalDirectoryObjectId })
                $g.ManagedBy = @($g.ManagedBy | Where-Object { $drop -notcontains $_ })
            }
        }
    }
    New-Stub 'Get-DistributionGroupMember' {
        param($Identity, $ResultSize)
        $g = & $global:AfFindRx $Identity
        @($global:AfRx.Members[$g.PrimarySmtpAddress]) | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ PrimarySmtpAddress = $_ } }
    }
    New-Stub 'Add-DistributionGroupMember' {
        param($Identity, $Member, [switch]$Confirm)
        $g = & $global:AfFindRx $Identity
        & $global:AfAssertOwner $g $false
        if ($Member -like 'nobody@*') { throw "Couldn't find object '$Member'." }
        $global:AfRx.Calls.Add("Add-DistributionGroupMember $Identity $Member")
        $global:AfRx.Members[$g.PrimarySmtpAddress].Add($Member)
    }
    New-Stub 'Remove-Mailbox' {
        param($Identity, [switch]$Confirm)
        $r = & $global:AfFindRx $Identity
        $global:AfRx.Calls.Add("Remove-Mailbox $Identity")
        $global:AfRx.Recipients.Remove($r.PrimarySmtpAddress)
    }
    New-Stub 'Remove-DistributionGroup' {
        param($Identity, [switch]$Confirm, [switch]$BypassSecurityGroupManagerCheck)
        $g = & $global:AfFindRx $Identity
        & $global:AfAssertOwner $g ([bool]$BypassSecurityGroupManagerCheck)
        $global:AfRx.Calls.Add("Remove-DistributionGroup $Identity bypass=$([bool]$BypassSecurityGroupManagerCheck)")
        $global:AfRx.Recipients.Remove($g.PrimarySmtpAddress)
    }

    # A copy of $Base with $Over's keys replaced (hashtable + hashtable refuses duplicate keys).
    function script:With([hashtable]$Base, [hashtable]$Over = @{}) {
        $h = @{}
        foreach ($k in $Base.Keys) { $h[$k] = $Base[$k] }
        foreach ($k in $Over.Keys) { $h[$k] = $Over[$k] }
        $h
    }
    function script:Writes { @($global:AfRx.Calls | Where-Object { $_ -notlike 'Get-*' }) }
}

AfterAll {
    Remove-Stubs $script:StubNames
    Remove-Variable -Name AfRx, AfFindRx, AfAddRx, AfAssertOwner -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Get-RecipientAvailability' {
    BeforeEach { Reset-Directory }

    It 'passes the read-only policy and reports free and taken values, readable types and accepted domains' {
        $global:AfRx.Recipients['reception@example.com'].CustomAttribute15 = $script:Mark
        $r = Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ addresses = @('new@example.com', 'reception@example.com'); aliases = @('blake') }
        $r.Failure | Should -BeNullOrEmpty
        $out = $r.Output[0]
        $out.acceptedDomains | Should -Be @('example.com', 'example.onmicrosoft.com')
        $out.items[0].taken | Should -BeFalse
        $out.items[1].taken | Should -BeTrue
        $out.items[1].typeLabel | Should -Be 'a shared mailbox'
        $out.items[1].createdByAdminForge | Should -BeTrue
        $out.items[2].kind | Should -Be 'alias'
        $out.items[2].typeLabel | Should -Be 'a user mailbox'
        $out.items[2].createdByAdminForge | Should -BeFalse
    }

    It "resolves a list's owners to their Entra object ids" {
        $g = & $global:AfAddRx 'falcon@example.com' 'falcon' 'falcon' 'Project Falcon' 'MailUniversalDistributionGroup'
        $g.ManagedBy = @($script:Blake, 'gone-owner')
        $out = (Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ addresses = @('falcon@example.com') }).Output[0]
        $out.items[0].ownerObjectIds | Should -Be @($script:Blake)
    }

    It 'refuses an empty request, wildcards and malformed aliases' {
        (Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{}).Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ addresses = @('*@example.com') }).Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ aliases = @('bad alias') }).Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ aliases = @('.sales') }).Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ aliases = @('sa..les') }).Category | Should -Be 'input'
    }

    It 'never reports a value free when the lookup failed for another reason' {
        $throttled = Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ addresses = @('throttled@example.com') }
        $throttled.Category | Should -Be 'script'
        $throttled.Output | Should -BeNullOrEmpty
        $dup = Invoke-ContentScript 'exchange/Get-RecipientAvailability.ps1' @{ aliases = @('dup') }
        $dup.Category | Should -Be 'input'
        $dup.Failure.Exception.Message | Should -BeLike 'More than one recipient answers to dup*'
    }
}

Describe 'New-SharedMailbox' {
    BeforeAll {
        $script:Inputs = @{
            displayName = 'Sales inbox'; alias = 'sales'; primarySmtpAddress = 'sales@example.com'
            memberAddresses = @('blake@example.com'); memberObjectIds = @($script:Blake); sendAs = $true
        }
    }
    BeforeEach { Reset-Directory }

    It 'refuses read mode' {
        (Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' $script:Inputs).Category | Should -Be 'readOnly'
    }

    It 'creates it named after the alias, marks it straight away by its Exchange id and grants access' {
        $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' $script:Inputs -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $mbx = $global:AfRx.Recipients['sales@example.com']
        $global:AfRx.Calls[0] | Should -Be 'New-Mailbox SharedMailbox sales@example.com name=sales'
        $global:AfRx.Calls[1] | Should -Be "Set-Mailbox $($mbx.Guid) CustomAttribute15"
        $mbx.CustomAttribute15 | Should -BeLike 'AdminForge-created by avery@example.onmicrosoft.com on *'
        $out = $r.Output[0]
        $out.created | Should -BeTrue
        $out.accountDisabled | Should -BeTrue
        $out.fullAccessAdded | Should -Be @('blake@example.com')
        $out.sendAsAdded | Should -Be @('blake@example.com')
        $out.verified | Should -BeTrue
    }

    It "doesn't change sign-in itself (the playbook does, through Microsoft Graph) and reports what Exchange shows" {
        $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ memberAddresses = @(); memberObjectIds = @() }) -Mode write -User $script:Engineer
        $r.Output[0].accountDisabled | Should -BeTrue
        $r.Output[0].verified | Should -BeTrue
        $global:AfRx.Calls | Where-Object { $_ -like 'Set-Mailbox*AccountDisabled*' } | Should -BeNullOrEmpty
    }

    It 'refuses giving the engineer access, by account or by address, before anything changes' {
        $byId = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ memberAddresses = @('avery@example.com'); memberObjectIds = @($script:Avery) }) -Mode write -User $script:Engineer
        $byId.Category | Should -Be 'input'
        $byId.Failure.Exception.Message | Should -BeLike "You can't give yourself access*"
        $byUpn = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ memberAddresses = @('avery@example.onmicrosoft.com'); memberObjectIds = @($script:Avery) }) -Mode write -User @{ Upn = 'avery@example.onmicrosoft.com'; ObjectId = $null }
        $byUpn.Category | Should -Be 'input'
        Writes | Should -BeNullOrEmpty
    }

    It 'gives access only to user mailboxes in the organization, checked before anything changes' {
        foreach ($case in @(
                @{ Address = 'kim@partner.example'; Id = '10000000-0000-4000-8000-000000000005'; Label = 'a guest' },
                @{ Address = 'supplier@fabrikam.example'; Id = '10000000-0000-4000-8000-000000000006'; Label = 'a mail contact' },
                @{ Address = 'reception@example.com'; Id = '10000000-0000-4000-8000-000000000003'; Label = 'a shared mailbox' }
            )) {
            $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ memberAddresses = @($case.Address); memberObjectIds = @($case.Id) }) -Mode write -User $script:Engineer
            $r.Category | Should -Be 'input'
            $r.Failure.Exception.Message | Should -BeLike "$($case.Address) is $($case.Label)*"
        }
        $mismatch = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ memberObjectIds = @($script:Dana) }) -Mode write -User $script:Engineer
        $mismatch.Category | Should -Be 'input'
        Writes | Should -BeNullOrEmpty
    }

    It 'refuses an address another recipient uses, an unaccepted domain, a wildcard and an alias with stray dots' {
        foreach ($over in @(
                @{ primarySmtpAddress = 'reception@example.com'; alias = 'other' },
                @{ alias = 'blake' },
                @{ primarySmtpAddress = 'sales@contoso.example' },
                @{ primarySmtpAddress = 'sa*@example.com' },
                @{ alias = 'sales.' }
            )) {
            (Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs $over) -Mode write -User $script:Engineer).Category | Should -Be 'input'
        }
        Writes | Should -BeNullOrEmpty
    }

    It 'stops instead of creating when Exchange could not check the address' {
        $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ primarySmtpAddress = 'throttled@example.com'; alias = 'throttled' }) -Mode write -User $script:Engineer
        $r.Category | Should -Be 'script'
        Writes | Should -BeNullOrEmpty
    }

    It 'finishes its own mailbox on a second run only when told which mailbox it is' {
        Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' $script:Inputs -Mode write -User $script:Engineer | Out-Null
        $id = $global:AfRx.Recipients['sales@example.com'].ExternalDirectoryObjectId
        $global:AfRx.Calls.Clear()
        (Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' $script:Inputs -Mode write -User $script:Engineer).Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ existingObjectId = $script:Dana }) -Mode write -User $script:Engineer).Category | Should -Be 'input'
        Writes | Should -BeNullOrEmpty
        $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ existingObjectId = $id }) -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].created | Should -BeFalse
        @($r.Output[0].skipped).Count | Should -Be 2
        Writes | Where-Object { $_ -like 'New-Mailbox*' -or $_ -like 'Add-*' } | Should -BeNullOrEmpty
    }

    It 'refuses to finish an address that no longer exists, and permissions on the mailbox itself' {
        (Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ existingObjectId = $script:Dana }) -Mode write -User $script:Engineer).Category | Should -Be 'input'
        Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ memberAddresses = @(); memberObjectIds = @() }) -Mode write -User $script:Engineer | Out-Null
        $id = $global:AfRx.Recipients['sales@example.com'].ExternalDirectoryObjectId
        $self = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ existingObjectId = $id; memberAddresses = @('sales@example.com'); memberObjectIds = @($id) }) -Mode write -User $script:Engineer
        $self.Category | Should -Be 'input'
    }

    It 'lists a failed grant, asks for a re-run, and the re-run grants only what is missing' {
        $both = With $script:Inputs @{ memberAddresses = @('blake@example.com', 'dana@example.com'); memberObjectIds = @($script:Blake, $script:Dana) }
        $global:AfRx.FailGrant = @('dana@example.com')
        $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' $both -Mode write -User $script:Engineer
        $r.Category | Should -Be 'script'
        $r.Failure.Exception.Message | Should -BeLike '*Full Access for dana@example.com*Run the playbook again*'
        $r.Output[0].failed[0].member | Should -Be 'dana@example.com'
        $r.Output[0].fullAccessAdded | Should -Be @('blake@example.com')
        $global:AfRx.FailGrant = @()
        $global:AfRx.Calls.Clear()
        $id = $global:AfRx.Recipients['sales@example.com'].ExternalDirectoryObjectId
        $again = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $both @{ existingObjectId = $id }) -Mode write -User $script:Engineer
        $again.Failure | Should -BeNullOrEmpty
        $again.Output[0].fullAccessAdded | Should -Be @('dana@example.com')
        @(Writes | Where-Object { $_ -like 'Add-*' }) | Should -Be @('Add-MailboxPermission sales@example.com dana@example.com')
    }

    It 'leaves a marked mailbox when Exchange is slow, which a re-run then finishes' {
        $global:AfRx.Pending = @('sales@example.com')
        $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' $script:Inputs -Mode write -User $script:Engineer
        $r.Category | Should -Be 'script'
        $r.Failure.Exception.Message | Should -BeLike "*isn't ready yet. Run the playbook again*"
        $mbx = $global:AfRx.Recipients['sales@example.com']
        $mbx.CustomAttribute15 | Should -BeLike 'AdminForge-created*'
        $global:AfRx.Pending = @()
        $again = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ existingObjectId = $mbx.ExternalDirectoryObjectId }) -Mode write -User $script:Engineer
        $again.Failure | Should -BeNullOrEmpty
        $again.Output[0].fullAccessAdded | Should -Be @('blake@example.com')
    }

    It 'treats the mark only as a guard rail: a marked user mailbox is still refused' {
        $r = Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' (With $script:Inputs @{ primarySmtpAddress = 'ceo@example.com'; alias = 'ceo'; existingObjectId = '10000000-0000-4000-8000-000000000007' }) -Mode write -User $script:Engineer
        $r.Category | Should -Be 'input'
        $r.Failure.Exception.Message | Should -BeLike '*already used by a user mailbox*'
        Writes | Should -BeNullOrEmpty
    }
}

Describe 'New-RoomMailbox' {
    BeforeAll {
        $script:Inputs = @{ displayName = 'Room 4.01'; alias = 'room401'; primarySmtpAddress = 'room401@example.com'; capacity = 8; allowConflicts = $false; bookingWindowInDays = 90; maximumDurationHours = 4 }
    }
    BeforeEach { Reset-Directory }

    It 'refuses read mode' {
        (Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' $script:Inputs).Category | Should -Be 'readOnly'
    }

    It 'creates it, marks it straight away and sets capacity and booking options' {
        $r = Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' $script:Inputs -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $room = $global:AfRx.Recipients['room401@example.com']
        $global:AfRx.Calls[0] | Should -Be 'New-Mailbox RoomMailbox room401@example.com name=room401'
        $global:AfRx.Calls[1] | Should -Be "Set-Mailbox $($room.Guid) CustomAttribute15"
        $out = $r.Output[0]
        $out.created | Should -BeTrue
        $out.capacity | Should -Be 8
        $out.automateProcessing | Should -Be 'AutoAccept'
        $out.bookingWindowInDays | Should -Be 90
        $out.maximumDurationInMinutes | Should -Be 240
        $out.verified | Should -BeTrue
    }

    It 'applies the options to its own room on a second run, told which room it is' {
        Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' $script:Inputs -Mode write -User $script:Engineer | Out-Null
        $id = $global:AfRx.Recipients['room401@example.com'].ExternalDirectoryObjectId
        (Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' (With $script:Inputs @{ autoAccept = $false }) -Mode write -User $script:Engineer).Category | Should -Be 'input'
        $r = Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' (With $script:Inputs @{ autoAccept = $false; existingObjectId = $id }) -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].created | Should -BeFalse
        $r.Output[0].automateProcessing | Should -Be 'AutoUpdate'
    }

    It 'refuses bounds, an alias with stray dots and an address in use' {
        (Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' (With $script:Inputs @{ maximumDurationHours = 48 }) -Mode write).Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' (With $script:Inputs @{ alias = '.room401' }) -Mode write).Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/New-RoomMailbox.ps1' (With $script:Inputs @{ primarySmtpAddress = 'reception@example.com'; alias = 'reception2' }) -Mode write).Category | Should -Be 'input'
        Writes | Should -BeNullOrEmpty
    }
}

Describe 'New-DistributionList' {
    BeforeAll {
        $script:Inputs = @{
            displayName = 'Project Falcon'; alias = 'falcon'; primarySmtpAddress = 'falcon@example.com'
            ownerAddresses = @('blake@example.com'); ownerObjectIds = @($script:Blake)
            memberAddresses = @('dana@example.com', 'partner@fabrikam.example')
        }
    }
    BeforeEach { Reset-Directory }

    It 'refuses read mode and a list without owners' {
        (Invoke-ContentScript 'exchange/New-DistributionList.ps1' $script:Inputs).Category | Should -Be 'readOnly'
        (Invoke-ContentScript 'exchange/New-DistributionList.ps1' (With $script:Inputs @{ ownerAddresses = @(); ownerObjectIds = @() }) -Mode write -User $script:Engineer).Category | Should -Be 'input'
    }

    It "creates it with the engineer's mailbox address as a temporary owner, marks it straight away, adds members and steps the engineer down" {
        $r = Invoke-ContentScript 'exchange/New-DistributionList.ps1' $script:Inputs -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $g = $global:AfRx.Recipients['falcon@example.com']
        $global:AfRx.Calls[0] | Should -Be 'New-DistributionGroup falcon@example.com name=falcon owners=blake@example.com,avery@example.com'
        $global:AfRx.Calls[1] | Should -Be "Set-DistributionGroup $($g.Guid) CustomAttribute15"
        $out = $r.Output[0]
        $out.created | Should -BeTrue
        $out.owners | Should -Be @('blake@example.com')
        $out.membersAdded | Should -Be @('dana@example.com', 'partner@fabrikam.example')
        $out.allowExternalSenders | Should -BeFalse
        $out.youAreOwner | Should -BeFalse
        $out.verified | Should -BeTrue
    }

    It 'keeps the engineer as an owner when asked' {
        $r = Invoke-ContentScript 'exchange/New-DistributionList.ps1' (With $script:Inputs @{ keepMeAsOwner = $true }) -Mode write -User $script:Engineer
        $r.Output[0].owners | Should -Be @('blake@example.com', 'avery@example.com')
        $r.Output[0].youAreOwner | Should -BeTrue
        $r.Output[0].verified | Should -BeTrue
    }

    It 'refuses an engineer without a mailbox, and owners who are guests, contacts or another account, before anything changes' {
        $noMailbox = Invoke-ContentScript 'exchange/New-DistributionList.ps1' $script:Inputs -Mode write -User @{ Upn = 'newhire@example.com'; ObjectId = '10000000-0000-4000-8000-000000000099' }
        $noMailbox.Category | Should -Be 'input'
        $noMailbox.Failure.Exception.Message | Should -BeLike 'You need a mailbox in Exchange Online*'
        foreach ($over in @(
                @{ ownerAddresses = @('kim@partner.example'); ownerObjectIds = @('10000000-0000-4000-8000-000000000005') },
                @{ ownerAddresses = @('supplier@fabrikam.example'); ownerObjectIds = @('10000000-0000-4000-8000-000000000006') },
                @{ ownerObjectIds = @($script:Dana) }
            )) {
            (Invoke-ContentScript 'exchange/New-DistributionList.ps1' (With $script:Inputs $over) -Mode write -User $script:Engineer).Category | Should -Be 'input'
        }
        (Invoke-ContentScript 'exchange/New-DistributionList.ps1' (With $script:Inputs @{ primarySmtpAddress = 'falcon@contoso.example' }) -Mode write -User $script:Engineer).Category | Should -Be 'input'
        Writes | Should -BeNullOrEmpty
    }

    It 'stays an owner when a member fails, asks for a re-run, and the re-run finishes and steps down' {
        $r = Invoke-ContentScript 'exchange/New-DistributionList.ps1' (With $script:Inputs @{ memberAddresses = @('dana@example.com', 'nobody@example.com') }) -Mode write -User $script:Engineer
        $r.Category | Should -Be 'script'
        $r.Failure.Exception.Message | Should -BeLike '*nobody@example.com*still one of its owners: run the playbook again*'
        $r.Output[0].youAreOwner | Should -BeTrue
        $id = $global:AfRx.Recipients['falcon@example.com'].ExternalDirectoryObjectId
        $again = Invoke-ContentScript 'exchange/New-DistributionList.ps1' (With $script:Inputs @{ existingObjectId = $id }) -Mode write -User $script:Engineer
        $again.Failure | Should -BeNullOrEmpty
        $again.Output[0].created | Should -BeFalse
        $again.Output[0].membersAdded | Should -Be @('partner@fabrikam.example')
        $again.Output[0].youAreOwner | Should -BeFalse
    }

    It 'refuses a re-run once the engineer is no longer an owner, without touching the list' {
        Invoke-ContentScript 'exchange/New-DistributionList.ps1' $script:Inputs -Mode write -User $script:Engineer | Out-Null
        $id = $global:AfRx.Recipients['falcon@example.com'].ExternalDirectoryObjectId
        $global:AfRx.Calls.Clear()
        $r = Invoke-ContentScript 'exchange/New-DistributionList.ps1' (With $script:Inputs @{ existingObjectId = $id; memberAddresses = @('blake@example.com') }) -Mode write -User $script:Engineer
        $r.Category | Should -Be 'input'
        $r.Failure.Exception.Message | Should -BeLike "You're not an owner of falcon@example.com*"
        Writes | Should -BeNullOrEmpty
    }

    It 'reports the list unverified when taking the engineer off the owners fails' {
        $global:AfRx.FailStepDown = $true
        $r = Invoke-ContentScript 'exchange/New-DistributionList.ps1' $script:Inputs -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].youAreOwner | Should -BeTrue
        $r.Output[0].verified | Should -BeFalse
    }
}

Describe 'Remove-CreatedRecipient' {
    BeforeEach { Reset-Directory }

    It 'removes only what AdminForge created, of the kind asked, matching the account — by its Exchange id' {
        Invoke-ContentScript 'exchange/New-SharedMailbox.ps1' @{ displayName = 'Sales inbox'; alias = 'sales'; primarySmtpAddress = 'sales@example.com' } -Mode write -User $script:Engineer | Out-Null
        $mbx = $global:AfRx.Recipients['sales@example.com']
        $id = $mbx.ExternalDirectoryObjectId
        (Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'sales@example.com'; objectId = $id; kind = 'sharedMailbox' }).Category | Should -Be 'readOnly'
        $kind = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'sales@example.com'; objectId = $id; kind = 'roomMailbox' } -Mode write -User $script:Engineer
        $kind.Category | Should -Be 'input'
        $kind.Failure.Exception.Message | Should -BeLike '*is a shared mailbox, not a room mailbox*'
        (Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'sales@example.com'; objectId = $script:Dana; kind = 'sharedMailbox' } -Mode write -User $script:Engineer).Category | Should -Be 'input'
        $global:AfRx.Calls.Clear()
        $r = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'sales@example.com'; objectId = $id; kind = 'sharedMailbox' } -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].removed | Should -BeTrue
        Writes | Should -Be @("Remove-Mailbox $($mbx.Guid)")
        $again = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'sales@example.com'; objectId = $id; kind = 'sharedMailbox' } -Mode write -User $script:Engineer
        $again.Output[0].removed | Should -BeFalse
    }

    It 'refuses a recipient AdminForge did not create, and a marked one of another kind' {
        (Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'reception@example.com'; objectId = '10000000-0000-4000-8000-000000000003'; kind = 'sharedMailbox' } -Mode write -User $script:Engineer).Category | Should -Be 'input'
        $forged = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'ceo@example.com'; objectId = '10000000-0000-4000-8000-000000000007'; kind = 'sharedMailbox' } -Mode write -User $script:Engineer
        $forged.Category | Should -Be 'input'
        $forged.Failure.Exception.Message | Should -BeLike '*is a user mailbox, not a shared mailbox*'
        Writes | Should -BeNullOrEmpty
    }

    It 'stops when Exchange could not read the recipient instead of calling it removed' {
        $r = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'throttled@example.com'; objectId = $script:Dana; kind = 'sharedMailbox' } -Mode write -User $script:Engineer
        $r.Category | Should -Be 'script'
        $r.Output | Should -BeNullOrEmpty
    }

    It "removes a list only for its owners, or with the owner check bypassed" {
        Invoke-ContentScript 'exchange/New-DistributionList.ps1' @{
            displayName = 'Project Falcon'; alias = 'falcon'; primarySmtpAddress = 'falcon@example.com'
            ownerAddresses = @('blake@example.com'); ownerObjectIds = @($script:Blake)
        } -Mode write -User $script:Engineer | Out-Null
        $g = $global:AfRx.Recipients['falcon@example.com']
        $global:AfRx.Calls.Clear()
        $notOwner = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'falcon@example.com'; objectId = $g.ExternalDirectoryObjectId; kind = 'distributionList' } -Mode write -User $script:Engineer
        $notOwner.Category | Should -Be 'input'
        $notOwner.Failure.Exception.Message | Should -BeLike "You're not an owner of falcon@example.com*Organization Management*"
        Writes | Should -BeNullOrEmpty
        $bypass = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'falcon@example.com'; objectId = $g.ExternalDirectoryObjectId; kind = 'distributionList'; bypassSecurityGroupManagerCheck = $true } -Mode write -User $script:Engineer
        $bypass.Failure | Should -BeNullOrEmpty
        Writes | Should -Be @("Remove-DistributionGroup $($g.Guid) bypass=True")
    }

    It 'removes a list the engineer owns' {
        Invoke-ContentScript 'exchange/New-DistributionList.ps1' @{
            displayName = 'Project Falcon'; alias = 'falcon'; primarySmtpAddress = 'falcon@example.com'
            ownerAddresses = @('blake@example.com'); ownerObjectIds = @($script:Blake); keepMeAsOwner = $true
        } -Mode write -User $script:Engineer | Out-Null
        $g = $global:AfRx.Recipients['falcon@example.com']
        $r = Invoke-ContentScript 'exchange/Remove-CreatedRecipient.ps1' @{ identity = 'falcon@example.com'; objectId = $g.ExternalDirectoryObjectId; kind = 'distributionList' } -Mode write -User $script:Engineer
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].removed | Should -BeTrue
    }
}
