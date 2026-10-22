#Requires -Version 7.4
# Set-InboxRuleState.ps1 doesn't turn on a rule in someone else's mailbox that sends their mail to the person running
# it, by SMTP address, alias or Exchange's legacy DN form ("Name [EX:/o=…]"). Synthetic data only.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')
    $script:StubNames = @('Get-InboxRule', 'Enable-InboxRule', 'Get-AcceptedDomain', 'Get-EXOMailbox', 'Get-EXORecipient')
    $script:Ids = @{ adele = '3c1d5e7f-0000-4000-8000-000000000103'; me = '3c1d5e7f-0000-4000-8000-0000000000a1' }
    New-Stub 'Get-AcceptedDomain' { @([pscustomobject]@{ DomainName = 'example.com' }) }
    New-Stub 'Get-InboxRule' {
        param($Mailbox, [switch]$IncludeHidden)
        @($global:AfIr.Rules | Where-Object { $_.Mailbox -eq $Mailbox }) | ForEach-Object { [pscustomobject]$_ }
    }
    New-Stub 'Enable-InboxRule' {
        param($Mailbox, $Identity, [switch]$Confirm, [switch]$Force)
        $global:AfIr.Calls.Add("Enable-InboxRule $Mailbox $Identity")
        (@($global:AfIr.Rules | Where-Object { $_.Mailbox -eq $Mailbox -and [string]$_.RuleIdentity -eq [string]$Identity })[0]).Enabled = $true
    }
    New-Stub 'Get-EXOMailbox' {
        param($Identity, $Properties)
        @{
            'adele@example.com'    = [pscustomobject]@{ PrimarySmtpAddress = 'adele@example.com'; ExternalDirectoryObjectId = $Ids.adele }
            'engineer@example.com' = [pscustomobject]@{ PrimarySmtpAddress = 'engineer@example.com'; ExternalDirectoryObjectId = $Ids.me }
        }[$Identity]
    }
    New-Stub 'Get-EXORecipient' {
        param($Identity, $Properties)
        if ($global:AfIr.RecipientFails) { throw 'The server is busy' }
        if ($Identity -notin @('engineer@example.com', $Ids.me)) { throw "Couldn't find object '$Identity'" }
        [pscustomobject]@{
            PrimarySmtpAddress = 'engineer@example.com'
            LegacyExchangeDN   = '/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=engineer'
            EmailAddresses     = @('SMTP:engineer@example.com', 'smtp:eng.alias@example.com', 'X500:/o=ExchangeLabs/cn=Recipients/cn=old-engineer')
        }
    }
    function New-Rule([string]$Mailbox, [string]$Id, [string[]]$ForwardTo, [string[]]$RedirectTo) {
        [ordered]@{ Mailbox = $Mailbox; Name = "Rule $Id"; RuleIdentity = [uint64]$Id; Enabled = $false; Priority = 1; Description = $null
            ForwardTo = $ForwardTo; ForwardAsAttachmentTo = $null; RedirectTo = $RedirectTo; DeleteMessage = $false; SoftDeleteMessage = $false; MoveToFolder = $null }
    }
}

AfterAll { Remove-Stubs $script:StubNames }

Describe 'Set-InboxRuleState.ps1 and rules that send mail to the person running it' {
    BeforeEach {
        $global:AfIr = @{
            Calls = [System.Collections.Generic.List[string]]::new()
            RecipientFails = $false
            Rules = [System.Collections.Generic.List[object]]::new([object[]]@(
                    (New-Rule 'adele@example.com' '101' @('"Eng" [SMTP:Eng.Alias@example.com]') $null),
                    (New-Rule 'adele@example.com' '102' @('"Engineer" [EX:/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=engineer]') $null),
                    (New-Rule 'adele@example.com' '103' $null @('"Old" [EX:/o=ExchangeLabs/cn=Recipients/cn=old-engineer]')),
                    (New-Rule 'adele@example.com' '104' @('"Desk" [SMTP:desk@example.com]') $null),
                    (New-Rule 'engineer@example.com' '105' @('"Eng" [SMTP:eng.alias@example.com]') $null),
                    (New-Rule 'adele@example.com' '106' @('"kim@example.com" [SMTP:eng.alias@example.com]') $null),
                    (New-Rule 'adele@example.com' '107' @('"eng.alias@example.com" [SMTP:desk@example.com]') $null)
                ))
        }
    }

    It 'refuses rule <id> in another mailbox that sends to you (alias, legacy DN or old X500)' -ForEach @(@{ id = '101' }, @{ id = '102' }, @{ id = '103' }) {
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = $id; action = 'enable' } 'write'
        $r.Category | Should -Be 'input'
        $r.Failure.Exception.Message | Should -Match 'sends its mail to you'
        $global:AfIr.Calls | Should -BeNullOrEmpty
    }

    It 'reads the recipient, not the display name the rule shows' {
        $spoofed = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '106'; action = 'enable' } 'write'
        $spoofed.Category | Should -Be 'input'
        $named = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '107'; action = 'enable' } 'write'
        $named.Failure | Should -BeNullOrEmpty
    }

    It 'finds your addresses by object id when your sign-in name has changed' {
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '101'; action = 'enable' } 'write' -User @{ Upn = 'renamed@example.com'; ObjectId = $Ids.me }
        $r.Category | Should -Be 'input'
    }

    It 'turns on a rule that sends to someone else inside the organization' {
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '104'; action = 'enable' } 'write'
        $r.Failure | Should -BeNullOrEmpty
        $global:AfIr.Calls | Should -Be @('Enable-InboxRule adele@example.com 104')
    }

    It 'turns on a rule in your own mailbox' {
        $r = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'engineer@example.com'; mailboxObjectId = $Ids.me; ruleIdentity = '105'; action = 'enable' } 'write' -User @{ Upn = 'engineer@example.com'; ObjectId = $Ids.me }
        $r.Failure | Should -BeNullOrEmpty
    }

    It 'stops when it cannot tell who is running it, or cannot read their addresses' {
        $nobody = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '104'; action = 'enable' } 'write' -User @{ Upn = ''; ObjectId = $null }
        $nobody.Category | Should -Be 'script'
        $global:AfIr.RecipientFails = $true
        $busy = Invoke-ContentScript 'exchange/Set-InboxRuleState.ps1' @{ mailbox = 'adele@example.com'; mailboxObjectId = $Ids.adele; ruleIdentity = '104'; action = 'enable' } 'write'
        $busy.Category | Should -Be 'script'
        $global:AfIr.Calls | Should -BeNullOrEmpty
    }
}
