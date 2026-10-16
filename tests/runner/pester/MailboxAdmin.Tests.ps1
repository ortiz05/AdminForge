#Requires -Version 7.4
# Mailbox access, forwarding, automatic replies, address-list visibility and inbox-rule scripts
# (portal/content/scripts/exchange). Exchange cmdlets are global stubs over an in-memory model of a few mailboxes.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')

    $script:StubNames = @(
        'Get-EXOMailbox', 'Get-EXORecipient', 'Get-EXOMailboxPermission', 'Get-EXORecipientPermission', 'Get-AcceptedDomain',
        'Add-MailboxPermission', 'Remove-MailboxPermission', 'Add-RecipientPermission', 'Remove-RecipientPermission',
        'Set-Mailbox', 'Get-MailboxAutoReplyConfiguration', 'Set-MailboxAutoReplyConfiguration', 'Get-InboxRule', 'Start-Sleep'
    )

    function script:Find-Mailbox([string]$Identity) {
        foreach ($m in $global:AfMx.Mailboxes.Values) {
            if ($m.PrimarySmtpAddress -ieq $Identity -or $m.UserPrincipalName -ieq $Identity) { return $m }
        }
        throw "Couldn't find object '$Identity'. Please make sure that it was spelled correctly."
    }
    $global:AfFindMailbox = ${function:script:Find-Mailbox}

    New-Stub 'Start-Sleep' { param($Seconds, $Milliseconds) }
    New-Stub 'Get-AcceptedDomain' { @([pscustomobject]@{ DomainName = 'example.com' }, [pscustomobject]@{ DomainName = 'example.onmicrosoft.com' }) }
    New-Stub 'Get-EXOMailbox' {
        param($Identity, $Properties, $ResultSize, $RecipientTypeDetails, $Filter)
        if ($Identity) { return & $global:AfFindMailbox $Identity }
        $all = @($global:AfMx.Mailboxes.Values)
        if ($RecipientTypeDetails) { $all = @($all | Where-Object { $_.RecipientTypeDetails -in $RecipientTypeDetails }) }
        if ($ResultSize -and $ResultSize -ne 'Unlimited') { $all = @($all | Select-Object -First ([int]$ResultSize)) }
        $all
    }
    New-Stub 'Get-EXORecipient' {
        param($Identity, $Properties)
        $r = $global:AfMx.Recipients[$Identity]
        if (-not $r) { throw "Couldn't find object '$Identity'." }
        $r
    }
    New-Stub 'Get-EXOMailboxPermission' {
        param($Identity, $User)
        $mbx = & $global:AfFindMailbox $Identity
        if ($User -and $User -like 'ghost@*') { throw "The user '$User' couldn't be found." }
        $global:AfMx.FullAccess | Where-Object { $_.Mailbox -eq $mbx.PrimarySmtpAddress -and (-not $User -or $_.User -ieq $User) } |
            ForEach-Object { [pscustomobject]$_ }
    }
    New-Stub 'Get-EXORecipientPermission' {
        param($Identity, $Trustee)
        $mbx = & $global:AfFindMailbox $Identity
        $global:AfMx.SendAs | Where-Object { $_.Mailbox -eq $mbx.PrimarySmtpAddress -and (-not $Trustee -or $_.Trustee -ieq $Trustee) } |
            ForEach-Object { [pscustomobject]$_ }
    }
    New-Stub 'Add-MailboxPermission' {
        param($Identity, $User, $AccessRights, $InheritanceType, $AutoMapping, [switch]$Confirm)
        if ($User -like 'broken@*') { throw "Couldn't add permission for '$User'." }
        $global:AfMx.Calls.Add("Add-MailboxPermission $Identity $User $AccessRights AutoMapping=$AutoMapping")
        $global:AfMx.FullAccess.Add(@{ Mailbox = $Identity; User = $User; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $false })
    }
    New-Stub 'Remove-MailboxPermission' {
        param($Identity, $User, $AccessRights, $InheritanceType, [switch]$Confirm)
        $global:AfMx.Calls.Add("Remove-MailboxPermission $Identity $User")
        $keep = @($global:AfMx.FullAccess | Where-Object { -not ($_.Mailbox -eq $Identity -and $_.User -ieq $User -and -not $_.IsInherited) })
        $global:AfMx.FullAccess = [System.Collections.Generic.List[object]]::new([object[]]$keep)
    }
    New-Stub 'Add-RecipientPermission' {
        param($Identity, $Trustee, $AccessRights, [switch]$Confirm)
        $global:AfMx.Calls.Add("Add-RecipientPermission $Identity $Trustee")
        $global:AfMx.SendAs.Add(@{ Mailbox = $Identity; Trustee = $Trustee; AccessRights = @('SendAs'); AccessControlType = 'Allow'; IsInherited = $false })
    }
    New-Stub 'Remove-RecipientPermission' {
        param($Identity, $Trustee, $AccessRights, [switch]$Confirm)
        $global:AfMx.Calls.Add("Remove-RecipientPermission $Identity $Trustee")
        $keep = @($global:AfMx.SendAs | Where-Object { -not ($_.Mailbox -eq $Identity -and $_.Trustee -ieq $Trustee) })
        $global:AfMx.SendAs = [System.Collections.Generic.List[object]]::new([object[]]$keep)
    }
    New-Stub 'Set-Mailbox' {
        param($Identity, $ForwardingSmtpAddress, $ForwardingAddress, $DeliverToMailboxAndForward, $HiddenFromAddressListsEnabled)
        $mbx = & $global:AfFindMailbox $Identity
        $global:AfMx.Calls.Add("Set-Mailbox $Identity $(($PSBoundParameters.Keys | Where-Object { $_ -ne 'Identity' } | Sort-Object) -join ',')")
        foreach ($k in $PSBoundParameters.Keys) { if ($k -ne 'Identity') { $mbx.$k = $PSBoundParameters[$k] } }
    }
    New-Stub 'Get-MailboxAutoReplyConfiguration' {
        param($Identity)
        $mbx = & $global:AfFindMailbox $Identity
        [pscustomobject]$global:AfMx.AutoReply[$mbx.PrimarySmtpAddress]
    }
    New-Stub 'Set-MailboxAutoReplyConfiguration' {
        param($Identity, $AutoReplyState, $InternalMessage, $ExternalMessage, $ExternalAudience, $StartTime, $EndTime, [switch]$Confirm)
        $mbx = & $global:AfFindMailbox $Identity
        $global:AfMx.Calls.Add("Set-MailboxAutoReplyConfiguration $Identity $AutoReplyState")
        $cfg = $global:AfMx.AutoReply[$mbx.PrimarySmtpAddress]
        $cfg.AutoReplyState = $AutoReplyState
        foreach ($k in 'InternalMessage', 'ExternalMessage', 'ExternalAudience', 'StartTime', 'EndTime') { if ($PSBoundParameters.ContainsKey($k)) { $cfg[$k] = $PSBoundParameters[$k] } }
    }
    New-Stub 'Get-InboxRule' {
        param($Mailbox, [switch]$IncludeHidden)
        if ($Mailbox -eq 'broken@example.com') { throw 'The mailbox is not available.' }
        $rules = @($global:AfMx.Rules[$Mailbox])
        if (-not $IncludeHidden) { $rules = @($rules | Where-Object { -not ($_ -and $_.ContainsKey('Hidden') -and $_['Hidden']) }) }
        $rules | Where-Object { $_ } | ForEach-Object { [pscustomobject]$_ }
    }
}

AfterAll {
    Remove-Stubs $StubNames
    Remove-Variable -Name AfMx, AfFindMailbox -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Exchange mailbox administration scripts' {
    BeforeEach {
        $mailbox = {
            param($Name, $Address, $Type, [hashtable]$Extra = @{})
            $m = [ordered]@{
                DisplayName = $Name; PrimarySmtpAddress = $Address; UserPrincipalName = $Address; RecipientTypeDetails = $Type
                IsDirSynced = $false; HiddenFromAddressListsEnabled = $false; LitigationHoldEnabled = $false; ArchiveStatus = 'None'
                ForwardingSmtpAddress = $null; ForwardingAddress = $null; DeliverToMailboxAndForward = $false; GrantSendOnBehalfTo = @()
            }
            foreach ($k in $Extra.Keys) { $m[$k] = $Extra[$k] }
            [pscustomobject]$m
        }
        $global:AfMx = @{
            Calls      = [System.Collections.Generic.List[string]]::new()
            Mailboxes  = [ordered]@{
                'adele@example.com'  = & $mailbox 'Adele Vance' 'adele@example.com' 'UserMailbox' @{ ForwardingSmtpAddress = 'smtp:adele.home@fabrikam.example'; DeliverToMailboxAndForward = $true }
                'sales@example.com'  = & $mailbox 'Sales' 'sales@example.com' 'SharedMailbox' @{ GrantSendOnBehalfTo = @('Lee Gu'); HiddenFromAddressListsEnabled = $true; ForwardingAddress = 'Partner Contact'; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000201' }
                'lee@example.com'    = & $mailbox 'Lee Gu' 'lee@example.com' 'UserMailbox' @{ IsDirSynced = $true }
                'broken@example.com' = & $mailbox 'Broken' 'broken@example.com' 'UserMailbox'
            }
            Recipients = @{
                'Lee Gu'          = [pscustomobject]@{ DisplayName = 'Lee Gu'; PrimarySmtpAddress = 'lee@example.com'; RecipientTypeDetails = 'UserMailbox'; ExternalEmailAddress = $null; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000102' }
                'lee@example.com' = [pscustomobject]@{ DisplayName = 'Lee Gu'; PrimarySmtpAddress = 'lee@example.com'; RecipientTypeDetails = 'UserMailbox'; ExternalEmailAddress = $null; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000102' }
                'kim@example.com' = [pscustomobject]@{ DisplayName = 'Kim Akers'; PrimarySmtpAddress = 'kim@example.com'; RecipientTypeDetails = 'UserMailbox'; ExternalEmailAddress = $null; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000101' }
                # Trustees of Set-MailboxPermission (it checks their object ids).
                'adele@example.com'  = [pscustomobject]@{ DisplayName = 'Adele Vance'; PrimarySmtpAddress = 'adele@example.com'; RecipientTypeDetails = 'UserMailbox'; ExternalEmailAddress = $null; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000103' }
                'broken@example.com' = [pscustomobject]@{ DisplayName = 'Broken'; PrimarySmtpAddress = 'broken@example.com'; RecipientTypeDetails = 'UserMailbox'; ExternalEmailAddress = $null; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000199' }
                'Partner Contact' = [pscustomobject]@{ DisplayName = 'Partner'; PrimarySmtpAddress = $null; RecipientTypeDetails = 'MailContact'; ExternalEmailAddress = 'SMTP:orders@fabrikam.example' }
            }
            FullAccess = [System.Collections.Generic.List[object]]::new([object[]]@(
                    @{ Mailbox = 'sales@example.com'; User = 'NT AUTHORITY\SELF'; AccessRights = @('FullAccess', 'ReadPermission'); IsInherited = $false; Deny = $false }
                    @{ Mailbox = 'sales@example.com'; User = 'kim@example.com'; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $false }
                    @{ Mailbox = 'sales@example.com'; User = 'lee@example.com'; AccessRights = 'FullAccess, ReadPermission'; IsInherited = $true; Deny = $false }
                    @{ Mailbox = 'sales@example.com'; User = 'S-1-5-21-1111-2222-3333-1105'; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $false }
                    @{ Mailbox = 'sales@example.com'; User = 'adele@example.com'; AccessRights = @('ReadPermission'); IsInherited = $false; Deny = $false }
                ))
            SendAs     = [System.Collections.Generic.List[object]]::new([object[]]@(
                    @{ Mailbox = 'sales@example.com'; Trustee = 'NT AUTHORITY\SELF'; AccessRights = @('SendAs'); AccessControlType = 'Allow'; IsInherited = $false }
                    @{ Mailbox = 'sales@example.com'; Trustee = 'kim@example.com'; AccessRights = @('SendAs'); AccessControlType = 'Allow'; IsInherited = $false }
                ))
            AutoReply  = @{
                'adele@example.com' = @{ AutoReplyState = 'Disabled'; ExternalAudience = 'None'; StartTime = $null; EndTime = $null }
                'sales@example.com' = @{ AutoReplyState = 'Enabled'; ExternalAudience = 'All'; StartTime = [datetime]'2026-10-01T08:00:00Z'; EndTime = [datetime]'2026-10-31T17:00:00Z' }
                'lee@example.com'   = @{ AutoReplyState = 'Disabled'; ExternalAudience = 'None'; StartTime = $null; EndTime = $null }
            }
            Rules      = @{
                'adele@example.com' = @(
                    @{ Name = 'Send to home'; Enabled = $true; Priority = 1; ForwardTo = @('"Adele Home" [SMTP:adele.home@fabrikam.example]'); RedirectTo = $null; DeleteMessage = $false; MoveToFolder = $null; MarkAsRead = $false; From = $null; SubjectContainsWords = @('invoice', 'payment') }
                    @{ Name = 'Hide bank mail'; Enabled = $true; Priority = 2; ForwardTo = $null; RedirectTo = $null; DeleteMessage = $false; MoveToFolder = 'adele@example.com:\RSS Feeds'; MarkAsRead = $true; From = @('bank@fabrikam.example') }
                    @{ Name = 'Team copy'; Enabled = $false; Priority = 3; ForwardTo = @('lee@example.com'); RedirectTo = $null; DeleteMessage = $false; MoveToFolder = $null; MarkAsRead = $false }
                    @{ Name = 'Newsletters'; Enabled = $true; Priority = 4; ForwardTo = $null; RedirectTo = $null; DeleteMessage = $false; MoveToFolder = 'Newsletters'; MarkAsRead = $false }
                    @{ Name = 'Hidden purge'; Hidden = $true; Enabled = $true; Priority = 5; ForwardTo = $null; RedirectTo = $null; DeleteMessage = $true; MoveToFolder = $null; MarkAsRead = $false }
                )
                'sales@example.com' = @(
                    @{ Name = 'Drop'; Enabled = $true; Priority = 1; ForwardTo = $null; RedirectTo = @('SMTP:collector@fabrikam.example'); DeleteMessage = $true; MoveToFolder = $null; MarkAsRead = $false }
                )
            }
        }
    }

    Describe 'Get-MailboxPermissions.ps1' {
        It 'lists Full Access, Send As and Send on Behalf, leaving out SELF and non-Full Access rights' {
            $r = Invoke-ContentScript 'exchange/Get-MailboxPermissions.ps1' @{ identity = 'sales@example.com' }
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.mailbox.recipientTypeDetails | Should -Be 'SharedMailbox'
            $o.summary.fullAccess | Should -Be 3
            $o.summary.sendAs | Should -Be 1
            $o.summary.sendOnBehalf | Should -Be 1
            $o.summary.inherited | Should -Be 1
            $o.summary.orphaned | Should -Be 1
            ($o.permissions | ForEach-Object { $_.key }) | Should -Be @(
                'fullaccess|kim@example.com', 'fullaccess|lee@example.com', 'fullaccess|s-1-5-21-1111-2222-3333-1105',
                'sendas|kim@example.com', 'sendonbehalf|lee@example.com')
        }

        It 'marks only explicit, resolvable grants as removable and resolves names' {
            $o = (Invoke-ContentScript 'exchange/Get-MailboxPermissions.ps1' @{ identity = 'sales@example.com' }).Output[0]
            $by = @{}; foreach ($p in $o.permissions) { $by[$p.key] = $p }
            $by['fullaccess|kim@example.com'].removable | Should -BeTrue
            $by['fullaccess|kim@example.com'].trusteeDisplayName | Should -Be 'Kim Akers'
            $by['fullaccess|lee@example.com'].inherited | Should -BeTrue
            $by['fullaccess|lee@example.com'].removable | Should -BeFalse
            $by['fullaccess|lee@example.com'].accessRights | Should -Be @('FullAccess', 'ReadPermission')
            $by['fullaccess|s-1-5-21-1111-2222-3333-1105'].orphaned | Should -BeTrue
            $by['fullaccess|s-1-5-21-1111-2222-3333-1105'].removable | Should -BeFalse
            $by['sendonbehalf|lee@example.com'].trustee | Should -Be 'lee@example.com'
            $by['sendonbehalf|lee@example.com'].removable | Should -BeTrue
            $by['sendonbehalf|lee@example.com'].trusteeAddress | Should -Be 'lee@example.com'
            $by['sendas|kim@example.com'].accessRights | Should -Be @('SendAs')
        }

        It 'reports an unknown mailbox or a malformed address as an input error' {
            (Invoke-ContentScript 'exchange/Get-MailboxPermissions.ps1' @{ identity = 'ghost@example.com' }).Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Get-MailboxPermissions.ps1' @{ identity = "x'; Remove-Mailbox" }).Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Get-MailboxPermissions.ps1' @{}).Category | Should -Be 'input'
        }
    }

    Describe 'Set-MailboxPermission.ps1' {
        BeforeAll { $SalesId = '3c1d5e7f-0000-4000-8000-000000000201' }

        It 'refuses to run in read mode' {
            $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' @{ identity = 'sales@example.com'; mailboxObjectId = $SalesId; trustee = 'lee@example.com'; trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000102'; action = 'add'; permissions = @('FullAccess') } 'read'
            $r.Category | Should -Be 'readOnly'
            $global:AfMx.Calls | Should -BeNullOrEmpty
        }

        It 'grants only what is missing and reads it back' {
            $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' @{ identity = 'sales@example.com'; mailboxObjectId = $SalesId; trustee = 'kim@example.com'; trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000101'; action = 'add'; permissions = @('FullAccess', 'SendAs') } 'write'
            $r.Failure | Should -BeNullOrEmpty
            $r.Output[0].changed | Should -BeNullOrEmpty
            @($r.Output[0].skipped).Count | Should -Be 2
            $global:AfMx.Calls | Should -BeNullOrEmpty

            $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' @{ identity = 'sales@example.com'; mailboxObjectId = $SalesId; trustee = 'adele@example.com'; trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000103'; action = 'add'; permissions = @('fullaccess', 'SendAs'); autoMapping = $false } 'write'
            $r.Failure | Should -BeNullOrEmpty
            $r.Output[0].changed | Should -Be @('FullAccess', 'SendAs')
            $r.Output[0].verified | Should -BeTrue
            $global:AfMx.Calls | Should -Be @(
                'Add-MailboxPermission sales@example.com adele@example.com FullAccess AutoMapping=False',
                'Add-RecipientPermission sales@example.com adele@example.com')
        }

        It 'removes explicit grants but never inherited ones' {
            $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' @{ identity = 'sales@example.com'; mailboxObjectId = $SalesId; trustee = 'kim@example.com'; trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000101'; action = 'remove'; permissions = @('FullAccess', 'SendAs') } 'write'
            $r.Output[0].changed | Should -Be @('FullAccess', 'SendAs')
            $r.Output[0].verified | Should -BeTrue
            $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' @{ identity = 'sales@example.com'; mailboxObjectId = $SalesId; trustee = 'lee@example.com'; trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000102'; action = 'remove'; permissions = @('FullAccess') } 'write'
            $r.Output[0].changed | Should -BeNullOrEmpty
            $r.Output[0].skipped[0].reason | Should -Be 'not granted directly'
            @($global:AfMx.FullAccess | Where-Object { $_.User -eq 'lee@example.com' }).Count | Should -Be 1
        }

        It 'reports a failed change and then fails the job' {
            $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' @{ identity = 'sales@example.com'; mailboxObjectId = $SalesId; trustee = 'broken@example.com'; trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000199'; action = 'add'; permissions = @('FullAccess', 'SendAs') } 'write'
            $r.Output[0].failed[0].permission | Should -Be 'FullAccess'
            $r.Output[0].changed | Should -Be @('SendAs')
            $r.Category | Should -Be 'script'
            $r.Failure.Exception.Message | Should -Match '1 of 2 permission changes failed'
        }

        It 'validates its inputs' {
            $base = @{ identity = 'sales@example.com'; mailboxObjectId = $SalesId; trustee = 'lee@example.com'; trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000102'; action = 'add'; permissions = @('FullAccess') }
            (Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' ($base + @{}) 'write').Category | Should -BeNullOrEmpty
            foreach ($bad in @(
                    @{ action = 'grant' }, @{ permissions = @('ReadPermission') }, @{ permissions = @() },
                    @{ trustee = 'sales@example.com' }, @{ trustee = 'not an address' }, @{ identity = 'ghost@example.com' },
                    @{ trustee = 'ghost@example.com' }, @{ mailboxObjectId = 'sales' }, @{ trusteeObjectId = $null },
                    @{ trusteeObjectId = '3c1d5e7f-0000-4000-8000-000000000101' }, @{ mailboxObjectId = '3c1d5e7f-0000-4000-8000-000000000102' })) {
                $inputs = $base.Clone(); foreach ($k in $bad.Keys) { $inputs[$k] = $bad[$k] }
                (Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' $inputs 'write').Category | Should -Be 'input' -Because ($bad | ConvertTo-Json -Compress)
            }
        }
    }

    Describe 'Get-MailboxConfiguration.ps1' {
        It 'reports forwarding (resolving contacts), visibility and automatic replies' {
            $o = (Invoke-ContentScript 'exchange/Get-MailboxConfiguration.ps1' @{ identity = 'adele@example.com' }).Output[0]
            $o.forwarding.enabled | Should -BeTrue
            $o.forwarding.forwardingSmtpAddress | Should -Be 'adele.home@fabrikam.example'
            $o.forwarding.external | Should -BeTrue
            $o.forwarding.deliverToMailboxAndForward | Should -BeTrue
            $o.autoReply.state | Should -Be 'Disabled'

            $o = (Invoke-ContentScript 'exchange/Get-MailboxConfiguration.ps1' @{ identity = 'sales@example.com' }).Output[0]
            $o.forwarding.forwardingAddress | Should -Be 'Partner Contact'
            $o.forwarding.forwardingAddressTarget | Should -Be 'orders@fabrikam.example'
            $o.hiddenFromAddressListsEnabled | Should -BeTrue
            $o.autoReply.startTime | Should -Be '2026-10-01T08:00:00.0000000Z'

            $o = (Invoke-ContentScript 'exchange/Get-MailboxConfiguration.ps1' @{ identity = 'lee@example.com'; includeAutoReply = $false }).Output[0]
            $o.forwarding.enabled | Should -BeFalse
            $o.forwarding.external | Should -BeNullOrEmpty
            $o.isDirSynced | Should -BeTrue
            $o.autoReply | Should -BeNullOrEmpty
        }

        It 'reports an unknown mailbox as an input error' {
            (Invoke-ContentScript 'exchange/Get-MailboxConfiguration.ps1' @{ identity = 'ghost@example.com' }).Category | Should -Be 'input'
        }
    }

    Describe 'Clear-MailboxForwarding.ps1' {
        It 'refuses to run in read mode' {
            (Invoke-ContentScript 'exchange/Clear-MailboxForwarding.ps1' @{ identity = 'adele@example.com' } 'read').Category | Should -Be 'readOnly'
            $global:AfMx.Calls | Should -BeNullOrEmpty
        }

        It 'clears every forwarding setting in one call and keeps the previous values' {
            $r = Invoke-ContentScript 'exchange/Clear-MailboxForwarding.ps1' @{ identity = 'adele@example.com' } 'write'
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.before.forwardingSmtpAddress | Should -Be 'adele.home@fabrikam.example'
            $o.before.deliverToMailboxAndForward | Should -BeTrue
            $o.after.forwardingSmtpAddress | Should -BeNullOrEmpty
            $o.changed | Should -BeTrue
            $o.verified | Should -BeTrue
            $global:AfMx.Calls | Should -Be @('Set-Mailbox adele@example.com DeliverToMailboxAndForward,ForwardingAddress,ForwardingSmtpAddress')
        }

        It 'is idempotent for a mailbox that does not forward' {
            $o = (Invoke-ContentScript 'exchange/Clear-MailboxForwarding.ps1' @{ identity = 'lee@example.com' } 'write').Output[0]
            $o.changed | Should -BeFalse
            $o.verified | Should -BeTrue
            $global:AfMx.Calls | Should -BeNullOrEmpty
        }

        It 'rejects unknown mailboxes and bad identities' {
            (Invoke-ContentScript 'exchange/Clear-MailboxForwarding.ps1' @{ identity = 'ghost@example.com' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Clear-MailboxForwarding.ps1' @{ identity = 'adele' } 'write').Category | Should -Be 'input'
        }
    }

    Describe 'Set-MailboxAutoReply.ps1' {
        It 'refuses to run in read mode' {
            (Invoke-ContentScript 'exchange/Set-MailboxAutoReply.ps1' @{ identity = 'adele@example.com'; state = 'Disabled' } 'read').Category | Should -Be 'readOnly'
        }

        It 'turns replies on with HTML-encoded messages' {
            $r = Invoke-ContentScript 'exchange/Set-MailboxAutoReply.ps1' @{ identity = 'adele@example.com'; state = 'enabled'; internalMessage = "Adele has left.`nContact <sales@example.com> & co." } 'write'
            $r.Failure | Should -BeNullOrEmpty
            $r.Output[0].before.state | Should -Be 'Disabled'
            $r.Output[0].after.state | Should -Be 'Enabled'
            $r.Output[0].verified | Should -BeTrue
            $cfg = $global:AfMx.AutoReply['adele@example.com']
            $cfg.InternalMessage | Should -Be 'Adele has left.<br>Contact &lt;sales@example.com&gt; &amp; co.'
            $cfg.ExternalMessage | Should -Be $cfg.InternalMessage
            $cfg.ExternalAudience | Should -Be 'All'
        }

        It 'schedules replies for a period and turns them off' {
            $r = Invoke-ContentScript 'exchange/Set-MailboxAutoReply.ps1' @{ identity = 'adele@example.com'; state = 'Scheduled'; internalMessage = 'Away'; externalMessage = 'Out of office'; externalAudience = 'Known'; startTime = '2026-10-20T09:00:00Z'; endTime = '2026-10-27' } 'write'
            $r.Failure | Should -BeNullOrEmpty
            $cfg = $global:AfMx.AutoReply['adele@example.com']
            $cfg.StartTime.ToString('o') | Should -Be '2026-10-20T09:00:00.0000000Z'
            $cfg.ExternalAudience | Should -Be 'Known'
            $cfg.ExternalMessage | Should -Be 'Out of office'

            $r = Invoke-ContentScript 'exchange/Set-MailboxAutoReply.ps1' @{ identity = 'sales@example.com'; state = 'Disabled' } 'write'
            $r.Output[0].after.state | Should -Be 'Disabled'
            $global:AfMx.Calls[-1] | Should -Be 'Set-MailboxAutoReplyConfiguration sales@example.com Disabled'
        }

        It 'validates its inputs' {
            $s = 'exchange/Set-MailboxAutoReply.ps1'
            (Invoke-ContentScript $s @{ identity = 'adele@example.com'; state = 'Enabled' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript $s @{ identity = 'adele@example.com'; state = 'Scheduled'; internalMessage = 'x'; startTime = '2026-10-20' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript $s @{ identity = 'adele@example.com'; state = 'Scheduled'; internalMessage = 'x'; startTime = '2026-10-20'; endTime = '2026-10-19' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript $s @{ identity = 'adele@example.com'; state = 'Scheduled'; internalMessage = 'x'; startTime = 'next monday'; endTime = '2026-10-19' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript $s @{ identity = 'adele@example.com'; state = 'On'; internalMessage = 'x' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript $s @{ identity = 'adele@example.com'; state = 'Enabled'; internalMessage = ('x' * 4001) } 'write').Category | Should -Be 'input'
            $global:AfMx.Calls | Should -BeNullOrEmpty
        }
    }

    Describe 'Set-MailboxAddressListVisibility.ps1' {
        It 'refuses to run in read mode' {
            (Invoke-ContentScript 'exchange/Set-MailboxAddressListVisibility.ps1' @{ identity = 'adele@example.com'; hidden = $true } 'read').Category | Should -Be 'readOnly'
        }

        It 'hides and shows a mailbox, and is idempotent' {
            $r = Invoke-ContentScript 'exchange/Set-MailboxAddressListVisibility.ps1' @{ identity = 'adele@example.com'; hidden = $true } 'write'
            $r.Output[0].before | Should -BeFalse
            $r.Output[0].after | Should -BeTrue
            $r.Output[0].verified | Should -BeTrue
            $r = Invoke-ContentScript 'exchange/Set-MailboxAddressListVisibility.ps1' @{ identity = 'sales@example.com'; hidden = $true } 'write'
            $r.Output[0].changed | Should -BeFalse
            $r = Invoke-ContentScript 'exchange/Set-MailboxAddressListVisibility.ps1' @{ identity = 'sales@example.com'; hidden = $false } 'write'
            $r.Output[0].after | Should -BeFalse
            $global:AfMx.Calls | Should -Be @('Set-Mailbox adele@example.com HiddenFromAddressListsEnabled', 'Set-Mailbox sales@example.com HiddenFromAddressListsEnabled')
        }

        It 'validates its inputs' {
            (Invoke-ContentScript 'exchange/Set-MailboxAddressListVisibility.ps1' @{ identity = 'adele@example.com' } 'write').Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Set-MailboxAddressListVisibility.ps1' @{ identity = 'adele@example.com'; hidden = 'yes' } 'write').Category | Should -Be 'input'
        }
    }

    Describe 'Get-InboxRules.ps1' {
        It 'flags external forwarding as high and hiding or deleting as medium, for one mailbox' {
            $r = Invoke-ContentScript 'exchange/Get-InboxRules.ps1' @{ identity = 'adele@example.com' }
            $r.Failure | Should -BeNullOrEmpty
            $o = $r.Output[0]
            $o.scope | Should -Be 'mailbox'
            $o.summary.rules | Should -Be 4
            ($o.rules | ForEach-Object { "$($_.ruleName)=$($_.risk)" }) | Should -Be @('Send to home=high', 'Hide bank mail=medium')
            $o.rules[0].externalTargets | Should -Be @('adele.home@fabrikam.example')
            $o.rules[0].conditions | Should -Be 'Subject contains: invoice, payment'
            $o.rules[1].reasons | Should -Be @('Moves messages to RSS Feeds', 'Marks messages as read')
        }

        It 'can return every rule, including hidden ones' {
            $o = (Invoke-ContentScript 'exchange/Get-InboxRules.ps1' @{ identity = 'adele@example.com'; riskyOnly = $false; includeHidden = $true }).Output[0]
            ($o.rules | ForEach-Object { "$($_.ruleName)=$($_.risk)" }) | Should -Be @(
                'Send to home=high', 'Hide bank mail=medium', 'Team copy=low', 'Newsletters=none', 'Hidden purge=medium')
            $o.summary.low | Should -Be 1
            $o.summary.deleting | Should -Be 1
        }

        It 'scans the organization, skipping mailboxes it cannot read' {
            $o = (Invoke-ContentScript 'exchange/Get-InboxRules.ps1' @{ maxMailboxes = 10 }).Output[0]
            $o.scope | Should -Be 'organization'
            $o.summary.mailboxesScanned | Should -Be 3
            $o.summary.mailboxesFailed | Should -Be 1
            $o.summary.high | Should -Be 2
            ($o.rules | Where-Object { $_.mailbox -eq 'sales@example.com' }).reasons | Should -Be @('Redirects outside the organization', 'Deletes messages')
        }

        It 'validates its inputs' {
            (Invoke-ContentScript 'exchange/Get-InboxRules.ps1' @{ identity = 'ghost@example.com' }).Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Get-InboxRules.ps1' @{ maxMailboxes = 0 }).Category | Should -Be 'input'
            (Invoke-ContentScript 'exchange/Get-InboxRules.ps1' @{ identity = 'a b@example.com' }).Category | Should -Be 'input'
        }
    }
}
