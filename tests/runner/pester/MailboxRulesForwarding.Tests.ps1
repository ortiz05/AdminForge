#Requires -Version 7.4
# Set-InboxRuleState.ps1 (turn an inbox rule off/on, remove it) and Set-MailboxForwarding.ps1 (forward to a user or
# shared mailbox inside the organization). Exchange cmdlets are global stubs over an in-memory model: rules carry a
# RuleIdentity, hidden rules (such as Exchange's own junk e-mail rule) only appear with -IncludeHidden and the rule
# cmdlets can't find them, ForwardingAddress holds the recipient's Name (often its Entra object id) as in Exchange
# Online, and every mailbox and recipient carries its ExternalDirectoryObjectId (synthetic ids).

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')

    $script:StubNames = @(
        'Get-InboxRule', 'Disable-InboxRule', 'Enable-InboxRule', 'Remove-InboxRule', 'Get-AcceptedDomain',
        'Get-EXOMailbox', 'Get-EXORecipient', 'Set-Mailbox', 'Start-Sleep'
    )
    New-Stub 'Start-Sleep' { param($Seconds, $Milliseconds) }
    New-Stub 'Get-AcceptedDomain' { @([pscustomobject]@{ DomainName = 'example.com' }, [pscustomobject]@{ DomainName = 'example.onmicrosoft.com' }) }
    New-Stub 'Get-InboxRule' {
        param($Mailbox, [switch]$IncludeHidden)
        if ($Mailbox -eq 'broken@example.com') { throw 'The mailbox is not available.' }
        @($global:AfRf.Rules | Where-Object { $_.Mailbox -eq $Mailbox -and ($IncludeHidden -or -not $_.Hidden) }) | ForEach-Object { [pscustomobject]$_ }
    }
    $find = {
        param($Mailbox, $Identity)
        $r = @($global:AfRf.Rules | Where-Object { $_.Mailbox -eq $Mailbox -and [string]$_.RuleIdentity -eq [string]$Identity -and -not $_.Hidden }) | Select-Object -First 1
        if (-not $r) { throw "||The operation couldn't be performed because object '$Mailbox\$Identity' couldn't be found." }
        $r
    }
    $global:AfRfFind = $find
    New-Stub 'Disable-InboxRule' {
        param($Mailbox, $Identity, [switch]$Confirm, [switch]$Force)
        if (-not $Force) { throw 'Confirmation required.' }
        $global:AfRf.Calls.Add("Disable-InboxRule $Identity")
        (& $global:AfRfFind $Mailbox $Identity).Enabled = $false
    }
    New-Stub 'Enable-InboxRule' {
        param($Mailbox, $Identity, [switch]$Confirm, [switch]$Force)
        if (-not $Force) { throw 'Confirmation required.' }
        $global:AfRf.Calls.Add("Enable-InboxRule $Identity")
        (& $global:AfRfFind $Mailbox $Identity).Enabled = $true
    }
    New-Stub 'Remove-InboxRule' {
        param($Mailbox, $Identity, [switch]$Confirm, [switch]$Force)
        if (-not $Force) { throw 'Confirmation required.' }
        $r = & $global:AfRfFind $Mailbox $Identity
        $global:AfRf.Calls.Add("Remove-InboxRule $Identity")
        $global:AfRf.Rules.Remove($r) | Out-Null
    }
    New-Stub 'Get-EXOMailbox' {
        param($Identity, $Properties)
        $m = $global:AfRf.Mailboxes[$Identity]
        if (-not $m) { throw "Couldn't find object '$Identity'." }
        $m
    }
    New-Stub 'Get-EXORecipient' {
        param($Identity, $Properties)
        foreach ($r in @($global:AfRf['Recipients'] | Where-Object { $_ })) { if ($Identity -in @($r.Name, $r.PrimarySmtpAddress)) { return $r } }
        throw "Couldn't find object '$Identity'."
    }
    New-Stub 'Set-Mailbox' {
        param($Identity, $ForwardingAddress, $DeliverToMailboxAndForward)
        $global:AfRf.Calls.Add("Set-Mailbox $Identity ForwardingAddress=$ForwardingAddress Keep=$DeliverToMailboxAndForward")
        if ($global:AfRf.Ignore) { return }
        $m = $global:AfRf.Mailboxes[$Identity]
        $m.ForwardingAddress = (Get-EXORecipient -Identity $ForwardingAddress).Name
        $m.DeliverToMailboxAndForward = $DeliverToMailboxAndForward
    }

    $script:Ids = @{
        adele  = '3c1d5e7f-0000-4000-8000-000000000103'
        lee    = '3c1d5e7f-0000-4000-8000-000000000102'
        desk   = '3c1d5e7f-0000-4000-8000-000000000104'
        sales  = '3c1d5e7f-0000-4000-8000-000000000201'
        front  = '3c1d5e7f-0000-4000-8000-000000000202'
        kim    = '3c1d5e7f-0000-4000-8000-000000000101'
        team   = '3c1d5e7f-0000-4000-8000-000000000301'
        onprem = '3c1d5e7f-0000-4000-8000-000000000105'
        me     = '3c1d5e7f-0000-4000-8000-0000000000a1'
    }
}

AfterAll {
    Remove-Stubs $StubNames
    Remove-Variable -Name AfRf, AfRfFind -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Set-InboxRuleState.ps1' {
    BeforeEach {
        $global:AfRf = @{
            Calls     = [System.Collections.Generic.List[string]]::new()
            Mailboxes = @{
                'adele@example.com' = [pscustomobject]@{ PrimarySmtpAddress = 'adele@example.com'; ExternalDirectoryObjectId = $Ids.adele }
            }
            Rules     = [System.Collections.Generic.List[object]]::new([object[]]@(
                    [ordered]@{ Mailbox = 'adele@example.com'; Name = 'Send to home'; RuleIdentity = [uint64]'17542359837015228417'; Enabled = $true; Priority = 1; Hidden = $false
                        Description = "If the message: includes 'invoice' in the subject`r`nTake the following actions: forward the message to 'adele.home@fabrikam.example'"
                        ForwardTo = @('"Adele Home" [SMTP:adele.home@fabrikam.example]'); ForwardAsAttachmentTo = $null; RedirectTo = $null; DeleteMessage = $false; SoftDeleteMessage = $false; MoveToFolder = $null }
                    [ordered]@{ Mailbox = 'adele@example.com'; Name = 'Junk E-mail Rule'; RuleIdentity = [uint64]'7278098472807432193'; Enabled = $true; Priority = 0; Hidden = $true
                        Description = $null; ForwardTo = $null; ForwardAsAttachmentTo = $null; RedirectTo = $null; DeleteMessage = $false; SoftDeleteMessage = $false; MoveToFolder = $null }
                    [ordered]@{ Mailbox = 'adele@example.com'; Name = 'Team copy'; RuleIdentity = [uint64]'17542359837015228419'; Enabled = $false; Priority = 2; Hidden = $false
                        Description = $null; ForwardTo = @('"Lee Gu" [EX:/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=lee]'); ForwardAsAttachmentTo = $null
                        RedirectTo = @('SMTP:desk@example.com'); DeleteMessage = $false; SoftDeleteMessage = $false; MoveToFolder = $null }
                    [ordered]@{ Mailbox = 'adele@example.com'; Name = 'Archive outside'; RuleIdentity = [uint64]'17542359837015228421'; Enabled = $false; Priority = 3; Hidden = $false
                        Description = $null; ForwardTo = $null; ForwardAsAttachmentTo = @('archive@fabrikam.example'); RedirectTo = $null; DeleteMessage = $false; SoftDeleteMessage = $false; MoveToFolder = $null }
                    [ordered]@{ Mailbox = 'adele@example.com'; Name = 'Redirect partner'; RuleIdentity = [uint64]'17542359837015228422'; Enabled = $false; Priority = 4; Hidden = $false
                        Description = $null; ForwardTo = $null; ForwardAsAttachmentTo = $null; RedirectTo = @('"Partner" [SMTP:orders@sub.fabrikam.example]'); DeleteMessage = $false; SoftDeleteMessage = $false; MoveToFolder = $null }
                ))
        }
        $base = @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '17542359837015228417'; ruleName = 'Send to home' }
    }

    It 'refuses to run in read mode' {
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($base + @{ action = 'disable' }) 'read').Category | Should -Be 'readOnly'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }

    It 'turns a rule off with -Force, reads it back and keeps what it did' {
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($base + @{ action = 'disable' }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $o = $r.Output[0]
        $o.changed | Should -BeTrue
        $o.verified | Should -BeTrue
        $o.before.enabled | Should -BeTrue
        $o.after.enabled | Should -BeFalse
        $o.rule.forwardTo | Should -Be @('"Adele Home" [SMTP:adele.home@fabrikam.example]')
        $o.rule.externalTargets | Should -Be @('"Adele Home" [SMTP:adele.home@fabrikam.example]')
        $o.rule.description | Should -Match 'forward the message'
        $global:AfRf.Calls | Should -Be @('Disable-InboxRule 17542359837015228417')
    }

    It 'is idempotent: a rule already off is left alone' {
        $global:AfRf.Rules[0].Enabled = $false
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($base + @{ action = 'disable' }) 'write'
        $r.Output[0].changed | Should -BeFalse
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }

    It 'never turns on a rule that forwards, forwards as attachment or redirects outside the organization' {
        $global:AfRf.Rules[0].Enabled = $false
        $forward = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($base + @{ action = 'enable' }) 'write'
        $forward.Category | Should -Be 'input'
        $forward.Failure.Exception.Message | Should -Match 'outside the organization'
        $forward.Failure.Exception.Message | Should -Match 'adele\.home@fabrikam\.example'
        foreach ($id in '17542359837015228421', '17542359837015228422') {
            $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = $id; action = 'enable' } 'write'
            $r.Category | Should -Be 'input' -Because $id
        }
        $global:AfRf.Calls | Should -BeNullOrEmpty
        # Turning them off (or removing them) stays possible.
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '17542359837015228421'; action = 'remove' } 'write').Failure | Should -BeNullOrEmpty
    }

    It 'turns on a rule that forwards inside the organization' {
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '17542359837015228419'; ruleName = 'Team copy'; action = 'enable' } 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].after.enabled | Should -BeTrue
        @($r.Output[0].rule.externalTargets).Count | Should -Be 0
        $global:AfRf.Calls | Should -Be @('Enable-InboxRule 17542359837015228419')
    }

    It 'removes a rule, and reports one that is already gone as unchanged' {
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($base + @{ action = 'remove' }) 'write'
        $r.Output[0].after.exists | Should -BeFalse
        $r.Output[0].verified | Should -BeTrue
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($base + @{ action = 'remove' }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].changed | Should -BeFalse
        @($global:AfRf.Calls | Where-Object { $_ -like 'Remove-InboxRule*' }).Count | Should -Be 1
    }

    It "refuses a mailbox whose account doesn't match the object id (the id the protected-object guard checked)" {
        $wrong = $base.Clone(); $wrong.mailboxObjectId = $Ids.lee; $wrong.action = 'disable'
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' $wrong 'write'
        $r.Category | Should -Be 'input'
        $r.Failure.Exception.Message | Should -Match "doesn't match the mailbox"
        $missing = $base.Clone(); $missing.Remove('mailboxObjectId'); $missing.action = 'disable'
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' $missing 'write').Category | Should -Be 'input'
        $wrong.mailboxObjectId = 'adele'
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' $wrong 'write').Category | Should -Be 'input'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }

    It 'refuses hidden rules, renamed rules, unknown rules and bad inputs' {
        $id = @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele }
        $hidden = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($id + @{ ruleIdentity = '7278098472807432193'; action = 'disable' }) 'write'
        $hidden.Category | Should -Be 'input'
        $hidden.Failure.Exception.Message | Should -Match 'hidden'
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($id + @{ ruleIdentity = '17542359837015228417'; ruleName = 'Something else'; action = 'disable' }) 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($id + @{ ruleIdentity = '1'; action = 'disable' }) 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($base + @{ action = 'delete' }) 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' ($id + @{ ruleIdentity = 'Send to home'; action = 'disable' }) 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'broken@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '1'; action = 'disable' } 'write').Category | Should -Be 'input'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }
}

Describe 'Set-MailboxForwarding.ps1' {
    BeforeEach {
        $mailbox = {
            param($Name, $Address, $Id, $Type, [hashtable]$Extra = @{})
            $m = [ordered]@{
                DisplayName = $Name; PrimarySmtpAddress = $Address; UserPrincipalName = $Address; ExternalDirectoryObjectId = $Id; RecipientTypeDetails = $Type
                ForwardingSmtpAddress = $null; ForwardingAddress = $null; DeliverToMailboxAndForward = $false
            }
            foreach ($k in $Extra.Keys) { $m[$k] = $Extra[$k] }
            [pscustomobject]$m
        }
        $recipient = {
            param($Name, $Address, $Id, $Type)
            [pscustomobject]@{ Name = $Name; DisplayName = $Name; PrimarySmtpAddress = $Address; RecipientTypeDetails = $Type; ExternalDirectoryObjectId = $Id }
        }
        $global:AfRf = @{
            Calls      = [System.Collections.Generic.List[string]]::new()
            Ignore     = $false
            Mailboxes  = @{
                'adele@example.com'    = & $mailbox 'Adele Vance' 'adele@example.com' $Ids.adele 'UserMailbox'
                'lee@example.com'      = & $mailbox 'Lee Gu' 'lee@example.com' $Ids.lee 'UserMailbox'
                'frontdesk@example.com' = & $mailbox 'Front desk' 'frontdesk@example.com' $Ids.front 'SharedMailbox'
                'sales@example.com'    = & $mailbox 'Sales' 'sales@example.com' $Ids.sales 'SharedMailbox' @{ ForwardingSmtpAddress = 'smtp:sales.archive@fabrikam.example' }
                'desk@example.com'     = & $mailbox 'Desk' 'desk@example.com' $Ids.desk 'SharedMailbox' @{ ForwardingAddress = $Ids.lee; DeliverToMailboxAndForward = $true }
                'kim@example.com'      = & $mailbox 'Kim Akers' 'kim@example.com' $Ids.kim 'UserMailbox' @{ ForwardingAddress = 'Front desk' }
                'avery@example.com'    = & $mailbox 'Avery Engineer' 'avery@example.com' $Ids.me 'UserMailbox'
            }
            Recipients = @(
                & $recipient $Ids.lee 'lee@example.com' $Ids.lee 'UserMailbox'
                & $recipient 'Front desk' 'frontdesk@example.com' $Ids.front 'SharedMailbox'
                & $recipient 'Sales' 'sales@example.com' $Ids.sales 'SharedMailbox'
                & $recipient 'Desk' 'desk@example.com' $Ids.desk 'SharedMailbox'
                & $recipient 'Kim Akers' 'kim@example.com' $Ids.kim 'UserMailbox'
                & $recipient 'Adele Vance' 'adele@example.com' $Ids.adele 'UserMailbox'
                & $recipient 'Avery Engineer' 'avery@example.com' $Ids.me 'UserMailbox'
                & $recipient 'Sales team' 'sales-team@example.com' $Ids.team 'MailUniversalDistributionGroup'
                & $recipient 'On-prem User' 'onprem.user@example.com' $Ids.onprem 'MailUser'
                & $recipient 'Partner' 'orders@fabrikam.example' $null 'MailContact'
            )
        }
        $forward = { param([hashtable]$Extra = @{}) $i = @{ identity = 'adele@example.com'; mailboxObjectId = $Ids.adele; target = 'lee@example.com'; targetObjectId = $Ids.lee }; foreach ($k in $Extra.Keys) { $i[$k] = $Extra[$k] }; $i }
    }

    It 'refuses to run in read mode' {
        (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward) 'read').Category | Should -Be 'readOnly'
    }

    It 'forwards to a user mailbox inside the organization and reads it back through its Name' {
        $r = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $o = $r.Output[0]
        $o.changed | Should -BeTrue
        $o.verified | Should -BeTrue
        $o.target.recipientTypeDetails | Should -Be 'UserMailbox'
        $o.after.forwardingAddress | Should -Be $Ids.lee
        $o.after.deliverToMailboxAndForward | Should -BeTrue
        $global:AfRf.Calls | Should -Be @('Set-Mailbox adele@example.com ForwardingAddress=lee@example.com Keep=True')
    }

    It 'forwards to a shared mailbox without keeping a copy' {
        $r = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'frontdesk@example.com'; targetObjectId = $Ids.front; deliverToMailboxAndForward = $false }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].after.deliverToMailboxAndForward | Should -BeFalse
        $r.Output[0].verified | Should -BeTrue
    }

    It "reports a change Exchange doesn't show yet as not verified" {
        $global:AfRf.Ignore = $true
        $r = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward) 'write'
        $r.Failure | Should -BeNullOrEmpty
        @($r.Output[0].changed, $r.Output[0].verified) | Should -Be @($true, $false)
        @($r.Events | Where-Object { $_.type -eq 'log' -and $_.level -eq 'warn' }).Count | Should -Be 1
    }

    It 'is idempotent for the same target and refuses to replace other forwarding' {
        $r = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' @{ identity = 'desk@example.com'; mailboxObjectId = $Ids.desk; target = 'lee@example.com'; targetObjectId = $Ids.lee } 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].changed | Should -BeFalse
        (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' @{ identity = 'desk@example.com'; mailboxObjectId = $Ids.desk; target = 'frontdesk@example.com'; targetObjectId = $Ids.front } 'write').Category | Should -Be 'input'
        (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' @{ identity = 'sales@example.com'; mailboxObjectId = $Ids.sales; target = 'lee@example.com'; targetObjectId = $Ids.lee } 'write').Category | Should -Be 'input'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }

    It 'refuses groups, mail users (hybrid), contacts and unknown addresses' {
        $group = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'sales-team@example.com'; targetObjectId = $Ids.team }) 'write'
        $group.Category | Should -Be 'input'
        $group.Failure.Exception.Message | Should -Match 'is a group'
        $mailUser = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'onprem.user@example.com'; targetObjectId = $Ids.onprem }) 'write'
        $mailUser.Category | Should -Be 'input'
        $mailUser.Failure.Exception.Message | Should -Match "mail user: its mailbox isn't in Exchange Online"
        $mailUser.Failure.Exception.Message | Should -Not -Match 'outside the organization'
        $contact = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'orders@fabrikam.example'; targetObjectId = $Ids.lee }) 'write'
        $contact.Category | Should -Be 'input'
        $contact.Failure.Exception.Message | Should -Match 'outside the organization'
        (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'nobody@example.com' }) 'write').Category | Should -Be 'input'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }

    It 'refuses a target mailbox that forwards its mail on (to an address or a recipient)' {
        $smtp = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'sales@example.com'; targetObjectId = $Ids.sales }) 'write'
        $smtp.Category | Should -Be 'input'
        $smtp.Failure.Exception.Message | Should -Match 'forwards its own mail to sales\.archive@fabrikam\.example'
        $recipient = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'kim@example.com'; targetObjectId = $Ids.kim }) 'write'
        $recipient.Category | Should -Be 'input'
        $recipient.Failure.Exception.Message | Should -Match 'forwards its own mail to frontdesk@example\.com'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }

    It 'refuses the mailbox itself and the person running the script (by object id or sign-in name)' {
        (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'adele@example.com'; targetObjectId = $Ids.adele }) 'write').Category | Should -Be 'input'
        $byId = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'avery@example.com'; targetObjectId = $Ids.me }) 'write' -User @{ Upn = 'someone.else@example.com'; ObjectId = $Ids.me.ToUpperInvariant() }
        $byId.Category | Should -Be 'input'
        $byId.Failure.Exception.Message | Should -Match 'to yourself'
        $byUpn = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ target = 'avery@example.com'; targetObjectId = $Ids.me }) 'write' -User @{ Upn = 'Avery@example.com'; ObjectId = $null }
        $byUpn.Failure.Exception.Message | Should -Match 'to yourself'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }

    It "refuses object ids that don't match the mailboxes (the ids the protected-object guard checked)" {
        $wrongMailbox = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ mailboxObjectId = $Ids.kim }) 'write'
        $wrongMailbox.Category | Should -Be 'input'
        $wrongMailbox.Failure.Exception.Message | Should -Match "doesn't match the mailbox"
        $wrongTarget = Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ targetObjectId = $Ids.kim }) 'write'
        $wrongTarget.Category | Should -Be 'input'
        $wrongTarget.Failure.Exception.Message | Should -Match "doesn't match that mailbox"
        foreach ($name in 'mailboxObjectId', 'targetObjectId') {
            $i = & $forward; $i.Remove($name)
            (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' $i 'write').Category | Should -Be 'input' -Because $name
            (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ $name = 'lee@example.com' }) 'write').Category | Should -Be 'input' -Because $name
        }
        (Invoke-ContentScript 'exchange/Set-MailboxForwarding.ps1' (& $forward @{ identity = 'ghost@example.com' }) 'write').Category | Should -Be 'input'
        $global:AfRf.Calls | Should -BeNullOrEmpty
    }
}
