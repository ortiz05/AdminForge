#Requires -Version 7.4
# OneDrive lookup and site collection administrators (portal/content/scripts/sharepoint): Get-OneDriveSite.ps1 (read)
# and Set-SiteCollectionAdmin.ps1 (write, OneDrives only). PnP cmdlets are global stubs over synthetic user profiles
# (CSOM PersonProperties: PersonalUrl and UserProfileProperties with msOnline-ObjectId) and a synthetic admin list
# ($global:AfSca.Admins, the tenant admin API's GetSiteSecondaryAdministrators shape).

BeforeAll {
    . (Join-Path $PSScriptRoot 'ContentScript.Helpers.ps1')
    $script:StubNames = @('Get-PnPUserProfileProperty', 'Get-PnPTenantSite', 'Set-PnPTenantSite', 'Invoke-PnPSPRestMethod')
    $script:Drive = 'https://example-my.sharepoint.com/personal/adele_example_com'
    $script:TeamSite = 'https://example.sharepoint.com/sites/ProjectAtlas'

    $script:Oid = @{
        adele = '10000000-0000-4000-8000-000000000001'; lee = '10000000-0000-4000-8000-000000000007'
        kim = '10000000-0000-4000-8000-000000000003'; noid = '10000000-0000-4000-8000-000000000009'
        flat = '10000000-0000-4000-8000-000000000010'; newhire = '10000000-0000-4000-8000-000000000011'
        me = '10000000-0000-4000-8000-0000000000a1'
    }
    $global:AfScaOid = $script:Oid
    # PnP returns CSOM PersonProperties: UserProfileProperties is a dictionary.
    $global:AfScaProfile = {
        param($Url, $Id)
        $props = [System.Collections.Generic.Dictionary[string, string]]::new()
        if ($Id) { $props['msOnline-ObjectId'] = $Id }
        $props['SPS-UserPrincipalName'] = 'x'
        [pscustomobject]@{ PersonalUrl = $Url; UserProfileProperties = $props }
    }
    New-Stub 'Get-PnPUserProfileProperty' {
        param($Account)
        $o = $global:AfScaOid
        switch ($Account) {
            'adele@example.com' { & $global:AfScaProfile 'https://example-my.sharepoint.com/personal/adele_example_com/' $o.adele }
            'lee@example.com' { & $global:AfScaProfile 'https://example-my.sharepoint.com/personal/lee_example_com/' $o.lee }
            'kim@example.com' { & $global:AfScaProfile 'https://example-my.sharepoint.com/personal/kim_example_com/' $o.kim }
            'noid@example.com' { & $global:AfScaProfile 'https://example-my.sharepoint.com/personal/noid_example_com/' $null }
            # Another shape: the properties flattened onto the object.
            'flat@example.com' { [pscustomobject]@{ PersonalUrl = 'https://example-my.sharepoint.com/personal/flat_example_com'; 'msOnline-ObjectId' = $o.flat } }
            'gone@example.com' { [pscustomobject]@{ PersonalUrl = 'https://example-my.sharepoint.com/personal/gone_example_com/' } }
            'busy@example.com' { [pscustomobject]@{ PersonalUrl = 'https://example-my.sharepoint.com/personal/busy_example_com/' } }
            'nodrive@example.com' { [pscustomobject]@{ PersonalUrl = '' } }
            'odd@example.com' { [pscustomobject]@{ PersonalUrl = 'https://fabrikam-my.sharepoint.com/personal/odd_example_com/' } }
            default { throw "User profile for '$Account' not found." }
        }
    }
    New-Stub 'Get-PnPTenantSite' {
        param($Identity)
        switch ($Identity) {
            'https://example-my.sharepoint.com/personal/adele_example_com' {
                [pscustomobject]@{ Url = $Identity; SiteId = [guid]'4c0b2d5e-9a1f-4e8b-8c3d-2f6a7b8c9d01'; Owner = 'adele@example.com'; OwnerEmail = 'adele@example.com'; LockState = 'Unlock'; StorageUsageCurrent = 2048; LastContentModifiedDate = [datetime]'2026-10-01T08:00:00Z' }
            }
            'https://example-my.sharepoint.com/personal/noid_example_com' {
                [pscustomobject]@{ Url = $Identity; SiteId = [guid]'4c0b2d5e-9a1f-4e8b-8c3d-2f6a7b8c9d03'; Owner = 'noid@example.com'; OwnerEmail = 'noid@example.com' }
            }
            'https://example-my.sharepoint.com/personal/flat_example_com' {
                [pscustomobject]@{ Url = $Identity; SiteId = [guid]'4c0b2d5e-9a1f-4e8b-8c3d-2f6a7b8c9d04'; Owner = 'i:0#.f|membership|flat@example.com'; OwnerEmail = '' }
            }
            'https://example.sharepoint.com/sites/ProjectAtlas' {
                [pscustomobject]@{ Url = $Identity; SiteId = [guid]'4c0b2d5e-9a1f-4e8b-8c3d-2f6a7b8c9d02'; Owner = ''; OwnerEmail = ''; LockState = 'Unlock'; StorageUsageCurrent = 512; LastContentModifiedDate = $null }
            }
            'https://example-my.sharepoint.com/personal/busy_example_com' { throw 'The remote server returned an error: (429) Too Many Requests.' }
            default { throw 'Cannot get site.' }
        }
    }
    New-Stub 'Set-PnPTenantSite' {
        param($Identity, $Owners)
        $global:AfSca.Calls.Add("Set-PnPTenantSite $Identity $($Owners -join ',')")
        if (-not $global:AfSca.Ignore) {
            foreach ($o in $Owners) { $global:AfSca.Admins.Add([pscustomobject]@{ loginName = "i:0#.f|membership|$o"; email = $o; userPrincipalName = $o }) }
        }
    }
    New-Stub 'Invoke-PnPSPRestMethod' {
        param($Method, $Url, $Content)
        $op = ($Url -split '/')[-1]
        $global:AfSca.Calls.Add("$Method $op")
        switch ($op) {
            'GetSiteSecondaryAdministrators' {
                $global:AfSca.Reads++
                # Hidden: logins SharePoint leaves out of the listed reads (a slow or flaky listing).
                $hide = if ($global:AfSca.HideOn -contains $global:AfSca.Reads) { @($global:AfSca.Hide) } else { @() }
                [pscustomobject]@{ value = @($global:AfSca.Admins | Where-Object { $hide -notcontains $_.loginName }) }
            }
            'SetSiteSecondaryAdministrators' {
                $global:AfSca.SetBody = $Content
                if ($global:AfSca.Ignore) { return $null }
                $keep = @($Content.secondaryAdministratorsFieldsData.secondaryAdministratorLoginNames)
                # DropOthers: SharePoint loses everyone else too (what the read-back must catch).
                $kept = if ($global:AfSca.DropOthers) { @() } else { @($global:AfSca.Admins | Where-Object { $_.loginName -in $keep }) }
                $global:AfSca.Admins.Clear()
                foreach ($a in $kept) { $global:AfSca.Admins.Add($a) }
                $null
            }
            default { throw "unexpected $op" }
        }
    }
}

AfterAll {
    Remove-Stubs $StubNames
    Remove-Variable -Name AfSca, AfScaOid, AfScaProfile -Scope Global -ErrorAction SilentlyContinue
}

Describe 'sharepoint/Get-OneDriveSite.ps1' {
    It "finds the owner's OneDrive and reads the site through the admin centre" {
        $r = Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'adele@example.com' }
        $r.Failure | Should -BeNullOrEmpty
        $o = $r.Output[0]
        $o.oneDriveUrl | Should -Be $Drive
        $o.exists | Should -BeTrue
        $o.storageUsedMB | Should -Be 2048
        $o.lastContentModified | Should -Be '2026-10-01T08:00:00.0000000Z'
    }

    It 'returns no URL when the person has no OneDrive, and exists = false when the site is gone' {
        $none = (Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'nodrive@example.com' }).Output[0]
        $none.oneDriveUrl | Should -BeNullOrEmpty
        $none.exists | Should -BeFalse
        $gone = Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'gone@example.com' }
        $gone.Output[0].oneDriveUrl | Should -Be 'https://example-my.sharepoint.com/personal/gone_example_com'
        $gone.Output[0].exists | Should -BeFalse
        @($gone.Events | Where-Object { $_.type -eq 'log' -and $_.level -eq 'warn' }).Count | Should -Be 1
    }

    It 'fails with the reason when the site cannot be read for another reason (not "no OneDrive")' {
        $r = Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'busy@example.com' }
        $r.Category | Should -Be 'script'
        $r.Failure.Exception.Message | Should -Match '429'
    }

    It "refuses another tenant's OneDrive, unknown people and bad input" {
        $odd = Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'odd@example.com' }
        $odd.Category | Should -Be 'script'
        $odd.Failure.Exception.Message | Should -Match 'not a OneDrive site of this tenant'
        (Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'ghost@example.com' }).Category | Should -Be 'input'
        (Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'adele' }).Category | Should -Be 'input'
        (Invoke-ContentScript 'sharepoint/Get-OneDriveSite.ps1' @{ owner = 'adele@example.com' } 'read' @{ Id = 'x'; Domain = 'example.com'; SpoTenantName = $null }).Category | Should -Be 'runner'
    }
}

Describe 'sharepoint/Set-SiteCollectionAdmin.ps1' {
    BeforeEach {
        $global:AfSca = @{
            Calls      = [System.Collections.Generic.List[string]]::new()
            Admins     = [System.Collections.Generic.List[object]]::new()
            Ignore     = $false
            DropOthers = $false
            SetBody    = $null
            Reads      = 0
            HideOn     = @()
            Hide       = @()
        }
        $global:AfSca.Admins.Add([pscustomobject]@{ loginName = 'c:0o.c|federateddirectoryclaimprovider|10000000-0000-4000-8000-000000000201_o'; email = ''; userPrincipalName = '' })
        $global:AfSca.Admins.Add([pscustomobject]@{ loginName = 'i:0#.f|membership|kim@example.com'; email = 'kim@example.com'; userPrincipalName = 'kim@example.com' })
        # Adele's OneDrive, and the person to add or remove (Lee unless the test says otherwise).
        $job = {
            param([string]$Action, [hashtable]$Extra = @{})
            $i = @{ siteUrl = $Drive; owner = 'adele@example.com'; ownerObjectId = $Oid.adele; user = 'lee@example.com'; userObjectId = $Oid.lee; action = $Action }
            foreach ($k in $Extra.Keys) { $i[$k] = $Extra[$k] }
            $i
        }
        $kim = @{ user = 'kim@example.com'; userObjectId = $Oid.kim }
        $writes = { @($global:AfSca.Calls | Where-Object { $_ -like 'Set-*' -or $_ -like '*SetSite*' }) }
    }

    It 'refuses to run in read mode' {
        (Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add) 'read').Category | Should -Be 'readOnly'
        $global:AfSca.Calls | Should -BeNullOrEmpty
    }

    It 'adds an administrator, keeps the others and reads the list back' {
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ siteUrl = "$Drive/" }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        $o = $r.Output[0]
        @($o.siteUrl, $o.before, $o.after, $o.changed, $o.verified, $o.administrators) | Should -Be @($Drive, $false, $true, $true, $true, 3)
        $global:AfSca.Calls | Should -Be @('Post GetSiteSecondaryAdministrators', "Set-PnPTenantSite $Drive lee@example.com", 'Post GetSiteSecondaryAdministrators')
    }

    It 'adding someone who already is an administrator sends nothing' {
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ user = 'KIM@example.com'; userObjectId = $Oid.kim }) 'write'
        @($r.Output[0].before, $r.Output[0].changed, $r.Output[0].verified) | Should -Be @($true, $false, $true)
        @(& $writes).Count | Should -Be 0
    }

    It 'retries the read-back also when nothing was sent, so existing access is confirmed rather than reported missing' {
        Mock -CommandName Start-Sleep -MockWith {}
        $global:AfSca.HideOn = @(2, 3)
        $global:AfSca.Hide = @('i:0#.f|membership|kim@example.com')
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add $kim) 'write'
        $r.Failure | Should -BeNullOrEmpty
        @($r.Output[0].before, $r.Output[0].changed, $r.Output[0].after, $r.Output[0].verified) | Should -Be @($true, $false, $true, $true)
        $global:AfSca.Reads | Should -Be 4
        @(& $writes).Count | Should -Be 0
    }

    It 'removes only that person; everyone else stays and is checked afterwards' {
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job remove $kim) 'write'
        $r.Failure | Should -BeNullOrEmpty
        @($r.Output[0].before, $r.Output[0].after, $r.Output[0].changed, $r.Output[0].verified, $r.Output[0].administrators) | Should -Be @($true, $false, $true, $true, 1)
        @($r.Output[0].missingAdministrators).Count | Should -Be 0
        $sent = $global:AfSca.SetBody.secondaryAdministratorsFieldsData
        $sent.siteId | Should -Be '4c0b2d5e-9a1f-4e8b-8c3d-2f6a7b8c9d01'
        @($sent.secondaryAdministratorLoginNames) | Should -Be @('c:0o.c|federateddirectoryclaimprovider|10000000-0000-4000-8000-000000000201_o')
    }

    It 'fails loudly when another administrator is gone after a removal, naming who to add back' {
        Mock -CommandName Start-Sleep -MockWith {}
        $global:AfSca.DropOthers = $true
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job remove $kim) 'write'
        $r.Category | Should -Be 'script'
        $r.Failure.Exception.Message | Should -Match 'no longer lists 1 other administrator'
        $r.Failure.Exception.Message | Should -Match 'federateddirectoryclaimprovider'
        @($r.Output[0].after, $r.Output[0].verified) | Should -Be @($false, $false)
        @($r.Output[0].missingAdministrators) | Should -Be @('c:0o.c|federateddirectoryclaimprovider|10000000-0000-4000-8000-000000000201_o')
    }

    It 'removing someone who is no administrator sends nothing' {
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job remove) 'write'
        @($r.Output[0].before, $r.Output[0].changed, $r.Output[0].verified, $r.Output[0].administrators) | Should -Be @($false, $false, $true, 2)
        $global:AfSca.SetBody | Should -BeNullOrEmpty
    }

    It "never adds or removes the OneDrive's owner" {
        foreach ($action in 'add', 'remove') {
            $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job $action @{ user = 'adele@example.com'; userObjectId = $Oid.adele }) 'write'
            $r.Category | Should -Be 'input'
            $r.Failure.Exception.Message | Should -Match 'owns this OneDrive'
        }
        $global:AfSca.Calls | Should -BeNullOrEmpty
    }

    It "confirms whose OneDrive it is from the owner's profile before changing anything" {
        $wrongOwner = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job remove @{ owner = 'kim@example.com'; ownerObjectId = $Oid.kim }) 'write'
        $wrongOwner.Category | Should -Be 'input'
        $wrongOwner.Failure.Exception.Message | Should -Match 'is not the OneDrive of kim@example.com'
        $wrongId = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ ownerObjectId = $Oid.kim }) 'write'
        $wrongId.Category | Should -Be 'input'
        $wrongId.Failure.Exception.Message | Should -Match "doesn't match their OneDrive"
        $noId = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ siteUrl = 'https://example-my.sharepoint.com/personal/noid_example_com'; owner = 'noid@example.com'; ownerObjectId = $Oid.noid }) 'write'
        $noId.Category | Should -Be 'script'
        $noId.Failure.Exception.Message | Should -Match "couldn't confirm whose OneDrive"
        (Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ owner = 'ghost@example.com' }) 'write').Category | Should -Be 'input'
        $global:AfSca.Calls | Should -BeNullOrEmpty
        # Properties flattened onto the profile object are read too.
        $flat = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ siteUrl = 'https://example-my.sharepoint.com/personal/flat_example_com'; owner = 'flat@example.com'; ownerObjectId = $Oid.flat }) 'write'
        $flat.Failure | Should -BeNullOrEmpty
        $flat.Output[0].verified | Should -BeTrue
    }

    It "checks the person's object id against their profile when SharePoint has one" {
        $wrong = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ userObjectId = $Oid.kim }) 'write'
        $wrong.Category | Should -Be 'input'
        $wrong.Failure.Exception.Message | Should -Match "doesn't match their SharePoint profile"
        $global:AfSca.Calls | Should -BeNullOrEmpty
        $noProfile = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ user = 'newhire@example.com'; userObjectId = $Oid.newhire }) 'write'
        $noProfile.Failure | Should -BeNullOrEmpty
        $noProfile.Output[0].verified | Should -BeTrue
        @($noProfile.Events | Where-Object { $_.type -eq 'log' -and $_.message -match 'no profile' }).Count | Should -Be 1
    }

    It 'refuses adding the person running it (by object id or sign-in name)' {
        $byId = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add) 'write' -User @{ Upn = 'someone@example.com'; ObjectId = $Oid.lee.ToUpperInvariant() }
        $byId.Category | Should -Be 'input'
        $byId.Failure.Exception.Message | Should -Match 'give yourself access'
        $byUpn = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add) 'write' -User @{ Upn = 'Lee@example.com'; ObjectId = $null }
        $byUpn.Category | Should -Be 'input'
        $global:AfSca.Calls | Should -BeNullOrEmpty
    }

    It 'force sends the removal even when the person is not listed yet (undoing an unconfirmed grant)' {
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job remove @{ force = $true }) 'write'
        $r.Failure | Should -BeNullOrEmpty
        @($r.Output[0].before, $r.Output[0].changed, $r.Output[0].verified, $r.Output[0].administrators) | Should -Be @($false, $true, $true, 2)
        @($global:AfSca.SetBody.secondaryAdministratorsFieldsData.secondaryAdministratorLoginNames).Count | Should -Be 2
    }

    It 'fails a removal after which SharePoint still lists the person (an undo is never reported as done)' {
        $global:AfSca.Ignore = $true
        Mock -CommandName Start-Sleep -MockWith {}
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job remove $kim) 'write'
        $r.Category | Should -Be 'script'
        $r.Failure.Exception.Message | Should -Match 'still lists kim@example.com'
        $r.Failure.Exception.Message | Should -Match 'in a few minutes'
        @($r.Output[0].after, $r.Output[0].verified) | Should -Be @($true, $false)
    }

    It "reports a change SharePoint doesn't show as not verified" {
        $global:AfSca.Ignore = $true
        Mock -CommandName Start-Sleep -MockWith {}
        $r = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add) 'write'
        $r.Failure | Should -BeNullOrEmpty
        @($r.Output[0].changed, $r.Output[0].after, $r.Output[0].verified) | Should -Be @($true, $false, $false)
    }

    It 'refuses team sites, sites of other tenants, unknown OneDrives and bad input before changing anything' {
        $team = Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add @{ siteUrl = $TeamSite }) 'write'
        $team.Category | Should -Be 'input'
        foreach ($bad in @(
                @{ siteUrl = 'https://fabrikam-my.sharepoint.com/personal/adele_example_com' },
                @{ siteUrl = 'https://example-my.sharepoint.com/personal/missing_example_com' },
                @{ siteUrl = 'http://example-my.sharepoint.com/personal/adele_example_com' },
                @{ siteUrl = 'https://example-my.sharepoint.com/sites/x' },
                @{ user = 'lee' }, @{ action = 'delete' },
                @{ owner = $null }, @{ ownerObjectId = $null }, @{ userObjectId = $null }, @{ userObjectId = 'lee@example.com' })) {
            $i = & $job add; foreach ($k in $bad.Keys) { if ($null -eq $bad[$k]) { $i.Remove($k) } else { $i[$k] = $bad[$k] } }
            (Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' $i 'write').Category | Should -Be 'input' -Because ($bad | ConvertTo-Json -Compress)
        }
        (Invoke-ContentScript 'sharepoint/Set-SiteCollectionAdmin.ps1' (& $job add) 'write' @{ Id = 'x'; Domain = 'example.com'; SpoTenantName = $null }).Category | Should -Be 'runner'
        @(& $writes).Count | Should -Be 0
    }
}
