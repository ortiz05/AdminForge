#Requires -Version 7.4
# Set-MailboxPermission.ps1: Send on Behalf (GrantSendOnBehalfTo), Exchange Online's "No permissions were found"
# answer for a trustee without permissions, and the object ids passed for the protected-object guard (they must match
# the mailbox's and the trustee's ExternalDirectoryObjectId; nobody grants themselves access). Exchange cmdlets are
# global stubs over an in-memory model; entries in GrantSendOnBehalfTo are recipient Names, which Exchange Online sets
# to the Entra object id for new recipients.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')

    $script:StubNames = @(
        'Get-EXOMailbox', 'Get-EXORecipient', 'Get-EXOMailboxPermission', 'Get-EXORecipientPermission',
        'Add-MailboxPermission', 'Remove-MailboxPermission', 'Add-RecipientPermission', 'Remove-RecipientPermission',
        'Set-Mailbox', 'Start-Sleep'
    )
    New-Stub 'Start-Sleep' { param($Seconds, $Milliseconds) }
    New-Stub 'Get-EXORecipient' {
        param($Identity)
        foreach ($r in $global:AfDg.Recipients) {
            if ($Identity -in @($r.Name, $r.PrimarySmtpAddress, $r.ExternalDirectoryObjectId)) { return $r }
        }
        throw "Couldn't find object '$Identity'."
    }
    New-Stub 'Get-EXOMailbox' {
        param($Identity, $Properties)
        $m = $global:AfDg.Mailboxes[$Identity]
        if (-not $m) { throw "Couldn't find object '$Identity'." }
        $m
    }
    New-Stub 'Get-EXOMailboxPermission' {
        param($Identity, $User)
        $rows = @($global:AfDg.FullAccess | Where-Object { $_.User -ieq $User })
        # What Exchange Online really answers for a trustee without permissions on the mailbox.
        if (-not $rows.Count) {
            throw "An error occurred while processing this request.. {`"error`":{`"code`":`"NotFound`",`"message`":`"No permissions were found for the user:$User`"}}"
        }
        $rows | ForEach-Object { [pscustomobject]$_ }
    }
    New-Stub 'Get-EXORecipientPermission' {
        param($Identity, $Trustee)
        @($global:AfDg.SendAs | Where-Object { $_.Trustee -ieq $Trustee }) | ForEach-Object { [pscustomobject]$_ }
    }
    New-Stub 'Add-MailboxPermission' {
        param($Identity, $User, $AccessRights, $InheritanceType, $AutoMapping, [switch]$Confirm)
        $global:AfDg.Calls.Add("Add-MailboxPermission $User")
        $global:AfDg.FullAccess.Add(@{ User = $User; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $false })
    }
    New-Stub 'Remove-MailboxPermission' { param($Identity, $User, $AccessRights, $InheritanceType, [switch]$Confirm) }
    New-Stub 'Add-RecipientPermission' { param($Identity, $Trustee, $AccessRights, [switch]$Confirm) }
    New-Stub 'Remove-RecipientPermission' { param($Identity, $Trustee, $AccessRights, [switch]$Confirm) }
    New-Stub 'Set-Mailbox' {
        param($Identity, $GrantSendOnBehalfTo, [switch]$Confirm)
        $global:AfDg.Calls.Add("Set-Mailbox $Identity GrantSendOnBehalfTo $(($GrantSendOnBehalfTo.Keys | Sort-Object) -join ',')")
        $m = $global:AfDg.Mailboxes[$Identity]
        # Exchange stores the recipient's Name, whatever identity it was given.
        if ($GrantSendOnBehalfTo.ContainsKey('Add')) {
            $name = (Get-EXORecipient -Identity $GrantSendOnBehalfTo['Add']).Name
            $m.GrantSendOnBehalfTo = @(@($m.GrantSendOnBehalfTo) + $name | Where-Object { $_ } | Select-Object -Unique)
        }
        if ($GrantSendOnBehalfTo.ContainsKey('Remove')) {
            $name = (Get-EXORecipient -Identity $GrantSendOnBehalfTo['Remove']).Name
            $m.GrantSendOnBehalfTo = @(@($m.GrantSendOnBehalfTo) | Where-Object { $_ -and $_ -ne $name })
        }
    }
}

AfterAll {
    Remove-Stubs $StubNames
    Remove-Variable -Name AfDg -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Set-MailboxPermission.ps1: Send on Behalf' {
    BeforeEach {
        $global:AfDg = @{
            Calls      = [System.Collections.Generic.List[string]]::new()
            Recipients = @(
                [pscustomobject]@{ Name = '3c1d5e7f-0000-4000-8000-000000000101'; Alias = 'kim'; PrimarySmtpAddress = 'kim@example.com'; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000101'; Guid = 'aa000000-0000-4000-8000-000000000101'; Identity = '3c1d5e7f-0000-4000-8000-000000000101' }
                [pscustomobject]@{ Name = 'Lee Gu'; Alias = 'lee'; PrimarySmtpAddress = 'lee@example.com'; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000102'; Guid = 'aa000000-0000-4000-8000-000000000102'; Identity = 'Lee Gu' }
            )
            Mailboxes  = @{
                'sales@example.com' = [pscustomobject]@{ DisplayName = 'Sales'; PrimarySmtpAddress = 'sales@example.com'; UserPrincipalName = 'sales@example.com'; ExternalDirectoryObjectId = '3c1d5e7f-0000-4000-8000-000000000201'; GrantSendOnBehalfTo = @('Lee Gu') }
            }
            FullAccess = [System.Collections.Generic.List[object]]::new()
            SendAs     = [System.Collections.Generic.List[object]]::new()
        }
        $sales = '3c1d5e7f-0000-4000-8000-000000000201'
        $kim = '3c1d5e7f-0000-4000-8000-000000000101'
        $lee = '3c1d5e7f-0000-4000-8000-000000000102'
        # identity + trustee with their object ids, plus whatever the test adds.
        $job = {
            param([string]$Trustee, [hashtable]$Extra)
            $i = @{ identity = 'sales@example.com'; mailboxObjectId = $sales; trustee = "$Trustee@example.com"; trusteeObjectId = $(if ($Trustee -eq 'kim') { $kim } else { $lee }) }
            foreach ($k in $Extra.Keys) { $i[$k] = $Extra[$k] }
            $i
        }
    }

    It 'adds Send on Behalf and reads it back through the recipient Name' {
        $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('sendonbehalf') }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].changed | Should -Be @('SendOnBehalf')
        $r.Output[0].verified | Should -BeTrue
        $global:AfDg.Calls | Should -Be @('Set-Mailbox sales@example.com GrantSendOnBehalfTo Add')
        $global:AfDg.Mailboxes['sales@example.com'].GrantSendOnBehalfTo | Should -Contain '3c1d5e7f-0000-4000-8000-000000000101'
    }

    It 'skips Send on Behalf the trustee already has and removes it on request' {
        $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job lee @{ action = 'add'; permissions = @('SendOnBehalf') }) 'write'
        $r.Output[0].changed | Should -BeNullOrEmpty
        $r.Output[0].skipped[0].reason | Should -Be 'already granted'
        $global:AfDg.Calls | Should -BeNullOrEmpty

        $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job lee @{ action = 'remove'; permissions = @('SendOnBehalf') }) 'write'
        $r.Output[0].changed | Should -Be @('SendOnBehalf')
        $r.Output[0].verified | Should -BeTrue
        @($global:AfDg.Mailboxes['sales@example.com'].GrantSendOnBehalfTo).Count | Should -Be 0
    }

    It 'reports Send on Behalf that is not there as skipped when removing' {
        $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'remove'; permissions = @('SendOnBehalf') }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].skipped[0].reason | Should -Be 'not granted directly'
    }

    It 'treats "No permissions were found" as not granted and grants Full Access' {
        $r = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('FullAccess', 'SendOnBehalf'); autoMapping = $false }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].changed | Should -Be @('FullAccess', 'SendOnBehalf')
        $r.Output[0].verified | Should -BeTrue
    }

    It 'still refuses a script in read mode and unknown permissions' {
        (Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('SendOnBehalf') }) 'read').Category | Should -Be 'readOnly'
        (Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('ReadPermission') }) 'write').Category | Should -Be 'input'
        $global:AfDg.Calls | Should -BeNullOrEmpty
    }

    It "refuses object ids that don't match the mailbox or the trustee (the ids the protected-object guard checked)" {
        $mailbox = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('FullAccess'); mailboxObjectId = $lee }) 'write'
        $mailbox.Category | Should -Be 'input'
        $mailbox.Failure.Exception.Message | Should -Match "doesn't match the mailbox"
        $trustee = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'remove'; permissions = @('FullAccess'); trusteeObjectId = $lee }) 'write'
        $trustee.Category | Should -Be 'input'
        $trustee.Failure.Exception.Message | Should -Match "doesn't match that recipient"
        foreach ($name in 'mailboxObjectId', 'trusteeObjectId') {
            $i = & $job kim @{ action = 'add'; permissions = @('FullAccess') }; $i.Remove($name)
            (Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' $i 'write').Category | Should -Be 'input' -Because $name
        }
        (Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('FullAccess'); trusteeObjectId = $sales }) 'write').Category | Should -Be 'input'
        $global:AfDg.Calls | Should -BeNullOrEmpty
    }

    It 'refuses giving the person running it access, but lets them remove their own' {
        $self = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('FullAccess') }) 'write' -User @{ Upn = 'k.akers@example.com'; ObjectId = $kim.ToUpperInvariant() }
        $self.Category | Should -Be 'input'
        $self.Failure.Exception.Message | Should -Match 'give yourself access'
        $byUpn = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job kim @{ action = 'add'; permissions = @('SendAs') }) 'write' -User @{ Upn = 'KIM@example.com'; ObjectId = $null }
        $byUpn.Category | Should -Be 'input'
        $global:AfDg.Calls | Should -BeNullOrEmpty
        $own = Invoke-ContentScript 'exchange/Set-MailboxPermission.ps1' (& $job lee @{ action = 'remove'; permissions = @('SendOnBehalf') }) 'write' -User @{ Upn = 'lee@example.com'; ObjectId = $lee }
        $own.Failure | Should -BeNullOrEmpty
        $own.Output[0].changed | Should -Be @('SendOnBehalf')
    }
}
