#Requires -Version 7.4
# Set-DistributionListMembers.ps1 refuses to add the person running it, under their sign-in name or any of their
# Exchange addresses: a mail-enabled security group grants access like any security group. Synthetic data only.

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')
    $script:StubNames = @('Get-EXORecipient', 'Get-DistributionGroup', 'Get-DistributionGroupMember', 'Add-DistributionGroupMember', 'Remove-DistributionGroupMember')
    $global:AfDl = @{}
    New-Stub 'Get-EXORecipient' {
        param($Identity, $Properties)
        if ($global:AfDl.RecipientFails) { throw 'The server is busy' }
        if ($Identity -eq 'team-dl@example.com') { return [pscustomobject]@{ RecipientTypeDetails = 'MailUniversalDistributionGroup' } }
        if ($Identity -eq 'new@example.com') { return [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox' } }
        # The caller, by sign-in name or (renamed, not yet in Exchange under the new name) by object id.
        if ($Identity -notin @('engineer@example.com', '3c1d5e7f-0000-4000-8000-0000000000a1')) { throw "Couldn't find object '$Identity'" }
        [pscustomobject]@{
            PrimarySmtpAddress = 'eng.primary@example.com'
            EmailAddresses     = @('SMTP:eng.primary@example.com', 'smtp:eng.alias@example.com', 'X500:/o=ExchangeLabs/cn=x', 'smtp:engineer@example.onmicrosoft.com')
        }
    }
    New-Stub 'Get-DistributionGroup' {
        param($Identity)
        if ($Identity -eq 'secure@example.com') { return [pscustomobject]@{ DisplayName = 'Finance Access'; PrimarySmtpAddress = 'secure@example.com'; RecipientTypeDetails = 'MailUniversalSecurityGroup' } }
        [pscustomobject]@{ DisplayName = 'Partners'; PrimarySmtpAddress = 'partners@example.com'; RecipientTypeDetails = 'MailUniversalDistributionGroup' }
    }
    New-Stub 'Get-DistributionGroupMember' { param($Identity, $ResultSize) @($global:AfDl.Members | ForEach-Object { [pscustomobject]@{ PrimarySmtpAddress = $_ } }) }
    New-Stub 'Add-DistributionGroupMember' { param($Identity, $Member, [switch]$Confirm, [switch]$BypassSecurityGroupManagerCheck) $global:AfDl.Adds++; $global:AfDl.Members.Add($Member) }
    New-Stub 'Remove-DistributionGroupMember' { param($Identity, $Member, [switch]$Confirm, [switch]$BypassSecurityGroupManagerCheck) [void]$global:AfDl.Members.Remove($Member) }
}

AfterAll { Remove-Stubs $script:StubNames }

Describe 'Set-DistributionListMembers refuses the person running it' {
    BeforeEach {
        $global:AfDl.Members = [System.Collections.Generic.List[string]]::new([string[]]@('kim@example.com'))
        $global:AfDl.Adds = 0
        $global:AfDl.RecipientFails = $false
    }

    It 'refuses <address> (sign-in name, primary address or alias) and changes nothing' -ForEach @(
        @{ address = 'engineer@example.com' }, @{ address = 'eng.primary@example.com' },
        @{ address = 'ENG.Alias@example.com' }, @{ address = 'engineer@example.onmicrosoft.com' }
    ) {
        $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'partners@example.com'; add = @('new@example.com', $address) } 'write'
        $r.Category | Should -Be 'input'
        "$($r.Failure)" | Should -Match "can't add yourself"
        $global:AfDl.Adds | Should -Be 0
    }

    It 'adds other people' {
        $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'partners@example.com'; add = @('new@example.com') } 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].added | Should -Be @('new@example.com')
    }

    It 'stops when it cannot tell who is running it, or cannot read their addresses' {
        $nobody = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'partners@example.com'; add = @('new@example.com') } 'write' -User @{ Upn = ''; ObjectId = $null }
        $nobody.Category | Should -Be 'script'
        $global:AfDl.RecipientFails = $true
        $busy = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'partners@example.com'; add = @('new@example.com') } 'write'
        $busy.Category | Should -Be 'script'
        $global:AfDl.Adds | Should -Be 0
    }

    It 'finds your aliases by object id when your sign-in name has changed' {
        $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'partners@example.com'; add = @('eng.alias@example.com') } 'write' -User @{ Upn = 'renamed.engineer@example.com'; ObjectId = '3c1d5e7f-0000-4000-8000-0000000000a1' }
        $r.Category | Should -Be 'input'
        $global:AfDl.Adds | Should -Be 0
    }

    It 'refuses nesting a list or group in a mail-enabled security group' {
        $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'secure@example.com'; add = @('new@example.com', 'team-dl@example.com') } 'write'
        $r.Category | Should -Be 'input'
        "$($r.Failure)" | Should -Match 'team-dl@example.com'
        $global:AfDl.Adds | Should -Be 0
        (Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'secure@example.com'; add = @('new@example.com') } 'write').Failure | Should -BeNullOrEmpty
    }

    It 'still nests a list in an ordinary distribution list' {
        $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'partners@example.com'; add = @('team-dl@example.com') } 'write'
        $r.Failure | Should -BeNullOrEmpty
    }

    It 'lets anyone remove members, themselves included, without the lookup' {
        $global:AfDl.RecipientFails = $true
        $global:AfDl.Members.Add('engineer@example.com')
        $r = Invoke-ContentScript 'exchange/Set-DistributionListMembers.ps1' @{ identity = 'partners@example.com'; remove = @('engineer@example.com') } 'write'
        $r.Failure | Should -BeNullOrEmpty
        $r.Output[0].removed | Should -Be @('engineer@example.com')
    }
}
