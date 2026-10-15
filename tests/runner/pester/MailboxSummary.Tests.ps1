#Requires -Version 7.4
# exchange/Get-MailboxSummary.ps1 with includeAccountState: the Entra object id and sign-in state of each mailbox's
# account (the Shared mailboxes page and the "Shared mailboxes with sign-in allowed" report). Get-EXOMailbox is a
# global stub over a few synthetic shared mailboxes.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')
    $script:StubNames = @('Get-EXOMailbox')

    $global:AfMs = @{
        Properties = $null
        Mailboxes  = @(
            [pscustomobject]@{ DisplayName = 'Reception'; UserPrincipalName = 'reception@example.com'; PrimarySmtpAddress = 'reception@example.com'; RecipientTypeDetails = 'SharedMailbox'; ExternalDirectoryObjectId = '10000000-0000-4000-8000-000000000c01'; WhenCreated = [datetime]'2024-08-06T09:00:00Z'; HiddenFromAddressListsEnabled = $false; LitigationHoldEnabled = $false; ArchiveStatus = 'None'; AccountDisabled = $false }
            [pscustomobject]@{ DisplayName = 'Invoices'; UserPrincipalName = 'invoices@example.com'; PrimarySmtpAddress = 'invoices@example.com'; RecipientTypeDetails = 'SharedMailbox'; ExternalDirectoryObjectId = '10000000-0000-4000-8000-000000000c02'; WhenCreated = [datetime]'2025-01-13T09:00:00Z'; HiddenFromAddressListsEnabled = $false; LitigationHoldEnabled = $false; ArchiveStatus = 'Active'; AccountDisabled = $true }
            # Deserialised from the REST module as text.
            [pscustomobject]@{ DisplayName = 'Support'; UserPrincipalName = 'support@example.com'; PrimarySmtpAddress = 'support@example.com'; RecipientTypeDetails = 'SharedMailbox'; ExternalDirectoryObjectId = '10000000-0000-4000-8000-000000000c03'; WhenCreated = $null; HiddenFromAddressListsEnabled = $false; LitigationHoldEnabled = $false; ArchiveStatus = 'None'; AccountDisabled = 'False' }
            # No account state and no object id returned.
            [pscustomobject]@{ DisplayName = 'Events'; UserPrincipalName = 'events@example.com'; PrimarySmtpAddress = 'events@example.com'; RecipientTypeDetails = 'SharedMailbox'; WhenCreated = $null; HiddenFromAddressListsEnabled = $false; LitigationHoldEnabled = $false; ArchiveStatus = 'None' }
        )
    }
    New-Stub 'Get-EXOMailbox' {
        param($ResultSize, $RecipientTypeDetails, $Properties)
        $global:AfMs.Properties = @($Properties)
        @($global:AfMs.Mailboxes | Where-Object { -not $RecipientTypeDetails -or $_.RecipientTypeDetails -in $RecipientTypeDetails })
    }
}

AfterAll {
    Remove-Stubs $StubNames
    Remove-Variable -Name AfMs -Scope Global -ErrorAction SilentlyContinue
}

Describe 'exchange/Get-MailboxSummary.ps1 includeAccountState' {
    It 'returns the object id and whether sign-in is blocked, reading AccountDisabled only when asked' {
        $r = Invoke-ContentScript 'exchange/Get-MailboxSummary.ps1' @{ recipientTypeDetails = @('SharedMailbox'); includeAccountState = $true }
        $r.Failure | Should -BeNullOrEmpty
        $global:AfMs.Properties | Should -Contain 'AccountDisabled'
        $rows = $r.Output[0].mailboxes
        $rows.Count | Should -Be 4
        ($rows | ForEach-Object { "$($_.primarySmtpAddress)=$($_.accountDisabled)" }) | Should -Be @(
            'reception@example.com=False', 'invoices@example.com=True', 'support@example.com=False', 'events@example.com=')
        $rows[0].externalDirectoryObjectId | Should -Be '10000000-0000-4000-8000-000000000c01'
        $rows[3].Contains('accountDisabled') | Should -BeTrue
        $null -eq $rows[3].accountDisabled | Should -BeTrue
        $null -eq $rows[3].externalDirectoryObjectId | Should -BeTrue
    }

    It 'keeps the original output when the account state is not asked for' {
        $r = Invoke-ContentScript 'exchange/Get-MailboxSummary.ps1' @{ recipientTypeDetails = @('SharedMailbox') }
        $r.Failure | Should -BeNullOrEmpty
        $global:AfMs.Properties | Should -Not -Contain 'AccountDisabled'
        $r.Output[0].mailboxes[0].Contains('accountDisabled') | Should -BeFalse
        $r.Output[0].mailboxes[0].Contains('externalDirectoryObjectId') | Should -BeFalse
    }

    It 'rejects a non-boolean includeAccountState' {
        $r = Invoke-ContentScript 'exchange/Get-MailboxSummary.ps1' @{ includeAccountState = 'yes' }
        $r.Category | Should -Be 'input'
    }
}
