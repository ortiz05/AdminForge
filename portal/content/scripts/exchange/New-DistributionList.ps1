<#
.SYNOPSIS
    Creates a distribution list with owners and members, marked as created by AdminForge.

.DESCRIPTION
    Exchange only lets a list's owners change it, so the engineer running this is an owner while it is set up: they
    need a recipient (a mailbox) in Exchange Online, checked first. Each owner is checked against the Entra object id
    the playbook resolved (ExternalDirectoryObjectId) before anything changes. Refuses an address or alias another
    recipient uses. A new list is created with New-DistributionGroup -Type Distribution (Name = alias, which the
    availability check covers), owned by the given owners and the engineer, and marked straight away by the id
    Exchange returns (CustomAttribute15 "AdminForge-created by <engineer> on <date>"), so a job that stops later leaves
    a list AdminForge can still finish or remove. Then it sets whether mail from outside the organization is accepted,
    adds the missing owners and members and — when everything succeeded and keepMeAsOwner is off — takes the engineer
    off the owners. When something failed the engineer stays an owner, so running the playbook again can retry it.
    When the address already belongs to a list AdminForge created, nothing is created again: existingObjectId must
    name that list, the engineer must still be one of its owners, and the run adds the owners and members that are
    missing (idempotent).
    The mark is a guard rail against mistakes, not a security boundary: anyone who can edit custom attributes can set
    it (SECURITY.md → Known gaps), which is why the playbooks ask for the address to be typed.

.PARAMETER Inputs
    displayName           string    Required. Display name, up to 64 characters.
    alias                 string    Required. Alias (mail nickname, also the Exchange name): letters, digits, dash,
                                    underscore, and dots between them; up to 64 characters.
    primarySmtpAddress    string    Required. Primary SMTP address in an accepted domain.
    existingObjectId      string    Entra object id of the list when an earlier run created it (required then).
    ownerAddresses        string[]  Required. Primary SMTP addresses of the owners (1–20; user mailboxes in this
                                    organization — no guests, contacts or shared mailboxes).
    ownerObjectIds        string[]  Required. Their Entra object ids, in the same order.
    memberAddresses       string[]  Addresses of the members (up to 1000).
    allowExternalSenders  bool      Accept mail from outside the organization (default false).
    keepMeAsOwner         bool      Keep the engineer running it as an owner too (default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ address; displayName; alias; externalDirectoryObjectId; created; owners; membersAdded; memberCount;
       allowExternalSenders; youAreOwner; skipped = @(@{ member; reason }); failed = @(@{ member; error }); verified }

.NOTES
    Tokens: exchange. Mode: write. Exchange role: Distribution Groups (Recipient Management).
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Context['Mode'] -ne 'write') {
    throw (New-AdminForgeError -Category readOnly -Message 'Creating a distribution list changes data; run this script in write mode (armed session).')
}
$smtp = '^[^\s@*]+@[^\s@*]+\.[^\s@*]+$'
$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$displayName = Get-AdminForgeInput $Inputs 'displayName' -Required -MaxLength 64 -Pattern '^[^<>;"]{1,64}$'
$alias = Get-AdminForgeInput $Inputs 'alias' -Required -MaxLength 64 -Pattern '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$'
$address = (Get-AdminForgeInput $Inputs 'primarySmtpAddress' -Required -Pattern $smtp -MaxLength 320).ToLowerInvariant()
$existingObjectId = Get-AdminForgeInput $Inputs 'existingObjectId' -Pattern $guid
$ownerInput = Get-AdminForgeInput $Inputs 'ownerAddresses' -Type StringArray -Pattern $smtp -MaxLength 320 -MaxCount 20
$ownerAddresses = @($ownerInput | ForEach-Object { $_.ToLowerInvariant() })
$ownerIdInput = Get-AdminForgeInput $Inputs 'ownerObjectIds' -Type StringArray -Pattern $guid -MaxCount 20
$ownerObjectIds = @($ownerIdInput | ForEach-Object { $_.ToLowerInvariant() })
$memberInput = Get-AdminForgeInput $Inputs 'memberAddresses' -Type StringArray -Pattern $smtp -MaxLength 320 -MaxCount 1000
$memberAddresses = @($memberInput | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
$allowExternal = Get-AdminForgeInput $Inputs 'allowExternalSenders' -Type Bool -Default $false
$keepMe = Get-AdminForgeInput $Inputs 'keepMeAsOwner' -Type Bool -Default $false
if ($ownerAddresses.Count -eq 0) {
    throw (New-AdminForgeError -Category input -Message 'A distribution list needs at least one owner.')
}
if ($ownerAddresses.Count -ne $ownerObjectIds.Count) {
    throw (New-AdminForgeError -Category input -Message 'Each owner needs both an address and an object id.')
}
$me = if ($Context['User'] -is [System.Collections.IDictionary] -and $Context['User']['Upn']) { [string]$Context['User']['Upn'] } else { '' }
if (-not $me) {
    throw (New-AdminForgeError -Category script -Message "AdminForge couldn't tell who is running this, so nothing was changed. Sign in again and retry.")
}

$labels = @{
    UserMailbox = 'a user mailbox'; SharedMailbox = 'a shared mailbox'; RoomMailbox = 'a room mailbox'
    EquipmentMailbox = 'an equipment mailbox'; MailUniversalDistributionGroup = 'a distribution list'
    MailUniversalSecurityGroup = 'a mail-enabled security group'; GroupMailbox = 'a Microsoft 365 group'
    MailUser = 'a mail user'; GuestMailUser = 'a guest'; MailContact = 'a mail contact'
}
function Get-Label([string]$Type) { if ($labels.ContainsKey($Type)) { $labels[$Type] } else { 'another recipient' } }
# A recipient by identity: $null only when Exchange says nobody uses it; any other failure stops the job.
function Find-Recipient([string]$Identity) {
    try {
        Get-EXORecipient -Identity $Identity -Properties CustomAttribute15 |
            Select-Object PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId, CustomAttribute15
    } catch {
        if ("$($_.Exception.Message) $($_.FullyQualifiedErrorId)" -match "couldn't find object|couldn't be found|ManagementObjectNotFound") { return $null }
        if ("$($_.Exception.Message)" -match 'matches multiple entries') {
            throw (New-AdminForgeError -Category input -Message "More than one recipient answers to $Identity, so nothing was changed. Pick another address or alias.")
        }
        Write-AdminForgeLog -Level Warn "Looking up $Identity failed: $($_.Exception.Message)"
        throw (New-AdminForgeError -Category script -Message "Exchange couldn't check $Identity just now, so nothing was changed. Try again in a few minutes.")
    }
}
# A list's owners (ManagedBy holds recipient names or object ids) as @{ id; address }; unresolvable ones are left out.
function Get-Owners($ManagedBy) {
    @($ManagedBy | Where-Object { $_ } | ForEach-Object {
            try {
                $o = Get-EXORecipient -Identity ([string]$_) | Select-Object PrimarySmtpAddress, ExternalDirectoryObjectId
                [pscustomobject]@{ id = ([string]$o.ExternalDirectoryObjectId).ToLowerInvariant(); address = ([string]$o.PrimarySmtpAddress).ToLowerInvariant() }
            } catch { $null }
        } | Where-Object { $_ })
}

$domain = $address.Split('@')[1]
$accepted = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() })
if ($accepted -notcontains $domain) {
    throw (New-AdminForgeError -Category input -Message "$domain isn't an accepted domain of this organization. Use one of: $($accepted -join ', ').")
}

Write-AdminForgeProgress -Percent 3 -Message 'Checking you can own the list'
$meRecipient = Find-Recipient $me
if (-not $meRecipient) {
    throw (New-AdminForgeError -Category input -Message "You need a mailbox in Exchange Online to set up a distribution list here: Exchange only lets a list's owners change it, and you are one while it is set up. Ask an engineer with a mailbox, or create the list in the Exchange admin center. Nothing was changed.")
}
$meAddress = ([string]$meRecipient.PrimarySmtpAddress).ToLowerInvariant()
$meId = ([string]$meRecipient.ExternalDirectoryObjectId).ToLowerInvariant()

Write-AdminForgeProgress -Percent 5 -Message 'Checking the owners'
for ($i = 0; $i -lt $ownerAddresses.Count; $i++) {
    $owner = Find-Recipient $ownerAddresses[$i]
    if (-not $owner) {
        throw (New-AdminForgeError -Category input -Message "No recipient uses $($ownerAddresses[$i]); an owner needs a mailbox, so nothing was changed.")
    }
    if (([string]$owner.ExternalDirectoryObjectId).ToLowerInvariant() -ne $ownerObjectIds[$i]) {
        throw (New-AdminForgeError -Category input -Message "The account given for $($ownerAddresses[$i]) doesn't match its mailbox, so nothing was changed. Start the playbook again.")
    }
    if ([string]$owner.RecipientTypeDetails -ne 'UserMailbox') {
        throw (New-AdminForgeError -Category input -Message "$($ownerAddresses[$i]) is $(Get-Label ([string]$owner.RecipientTypeDetails)). Owners must be people in your organization with a mailbox; nothing was changed.")
    }
}

$byAddress = Find-Recipient $address
$byAlias = Find-Recipient $alias
foreach ($hit in @($byAddress, $byAlias)) {
    if (-not $hit) { continue }
    $ours = ([string]$hit.CustomAttribute15).StartsWith('AdminForge-created') -and [string]$hit.RecipientTypeDetails -eq 'MailUniversalDistributionGroup' -and ([string]$hit.PrimarySmtpAddress).ToLowerInvariant() -eq $address
    if (-not $ours) {
        throw (New-AdminForgeError -Category input -Message "This address or alias is already used by $(Get-Label ([string]$hit.RecipientTypeDetails)) ($($hit.PrimarySmtpAddress)), so nothing was created. Pick another one.")
    }
}
if ($byAddress) {
    if (-not $existingObjectId) {
        throw (New-AdminForgeError -Category input -Message "$address already exists (AdminForge created it). Start the playbook again so it can check that list; nothing was changed.")
    }
    if ([string]$byAddress.ExternalDirectoryObjectId -ine $existingObjectId) {
        throw (New-AdminForgeError -Category input -Message "The list given for $address doesn't match the one in Exchange, so nothing was changed. Start the playbook again.")
    }
    $current = Get-DistributionGroup -Identity $address | Select-Object ManagedBy
    if (@(Get-Owners $current.ManagedBy | Where-Object { $_.id -eq $meId }).Count -eq 0) {
        throw (New-AdminForgeError -Category input -Message "You're not an owner of $address, and Exchange only lets a list's owners change it, so nothing was changed. Ask one of its owners to add what's missing, or someone with Organization Management.")
    }
} elseif ($existingObjectId) {
    throw (New-AdminForgeError -Category input -Message "$address no longer exists, so there is nothing to finish. Run the playbook again to create it.")
}

$marker = "AdminForge-created by $me on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))"
$created = $false
if (-not $byAddress) {
    Write-AdminForgeProgress -Percent 20 -Message 'Creating the distribution list'
    Write-AdminForgeLog "Creating distribution list $address ($displayName)"
    # The engineer is an owner at first: Exchange only lets an owner mark and configure the list.
    $managers = @($ownerAddresses)
    if ($managers -notcontains $meAddress) { $managers += $meAddress }
    $new = New-DistributionGroup -Name $alias -DisplayName $displayName -Alias $alias -PrimarySmtpAddress $address `
        -Type Distribution -ManagedBy $managers -MemberJoinRestriction Closed -MemberDepartRestriction Closed `
        -RequireSenderAuthenticationEnabled (-not $allowExternal) | Select-Object Guid
    $created = $true
    # Mark it straight away, by the id Exchange returned: an unmarked list could be neither finished nor removed by
    # AdminForge if the job stopped now.
    $exchangeId = if ([string]$new.Guid) { [string]$new.Guid } else { $address }
    $marked = $false
    for ($attempt = 1; $attempt -le 6 -and -not $marked; $attempt++) {
        try {
            Set-DistributionGroup -Identity $exchangeId -CustomAttribute15 $marker
            $marked = $true
        } catch {
            Write-AdminForgeLog -Level Warn "Marking $address (attempt $attempt): $($_.Exception.Message)"
            Start-Sleep -Seconds 5
        }
    }
    if (-not $marked) {
        throw (New-AdminForgeError -Category script -Message "Exchange created $address but didn't accept the AdminForge mark, so AdminForge can't finish or remove it. Ask an Exchange administrator to remove it in the Exchange admin center, then run the playbook again.")
    }
} else {
    Write-AdminForgeLog "$address was created by AdminForge before; adding the owners and members that are missing"
}

$group = $null
for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
        $group = Get-DistributionGroup -Identity $address |
            Select-Object PrimarySmtpAddress, ExternalDirectoryObjectId, CustomAttribute15, ManagedBy, RequireSenderAuthenticationEnabled
        if ($group -and [string]$group.ExternalDirectoryObjectId) { break }
    } catch { $group = $null }
    $group = $null
    Write-AdminForgeProgress -Percent (25 + 2 * $attempt) -Message "Waiting for Exchange ($attempt)"
    Start-Sleep -Seconds 10
}
if (-not $group) {
    throw (New-AdminForgeError -Category script -Message "Exchange created the list $address and it is marked as created by AdminForge, but it isn't ready yet. Run the playbook again in a few minutes; it finishes this list (you are still one of its owners).")
}

Write-AdminForgeProgress -Percent 55 -Message 'Setting senders and owners'
$settings = @{ Identity = $address; RequireSenderAuthenticationEnabled = (-not $allowExternal) }
if (-not ([string]$group.CustomAttribute15).StartsWith('AdminForge-created')) { $settings.CustomAttribute15 = $marker }
Set-DistributionGroup @settings

$skipped = [System.Collections.Generic.List[object]]::new()
$failed = [System.Collections.Generic.List[object]]::new()
$currentIds = @(Get-Owners $group.ManagedBy | ForEach-Object { $_.id })
$missingOwners = @(for ($i = 0; $i -lt $ownerAddresses.Count; $i++) { if ($currentIds -notcontains $ownerObjectIds[$i]) { $ownerAddresses[$i] } })
if ($missingOwners.Count) {
    try {
        Set-DistributionGroup -Identity $address -ManagedBy @{ Add = $missingOwners }
    } catch {
        foreach ($o in $missingOwners) { $failed.Add([ordered]@{ member = $o; error = "Not made an owner: $($_.Exception.Message)" }) }
    }
}

$added = [System.Collections.Generic.List[string]]::new()
$current = @(Get-DistributionGroupMember -Identity $address -ResultSize Unlimited | ForEach-Object { ([string]$_.PrimarySmtpAddress).ToLowerInvariant() })
$n = 0
foreach ($member in $memberAddresses) {
    $n++
    Write-AdminForgeProgress -Percent (60 + [Math]::Floor(25 * $n / [Math]::Max(1, $memberAddresses.Count))) -Message "Adding $member"
    if ($current -contains $member) { $skipped.Add([ordered]@{ member = $member; reason = 'already a member' }); continue }
    try {
        Add-DistributionGroupMember -Identity $address -Member $member -Confirm:$false
        $added.Add($member)
    } catch {
        $failed.Add([ordered]@{ member = $member; error = $_.Exception.Message })
    }
}

# Last, while still an owner: step down unless asked to stay — and only when nothing failed, so running the playbook
# again can retry what failed (Exchange only lets owners change the list).
$stayed = $keepMe -or $ownerAddresses -contains $meAddress
if (-not $stayed -and $failed.Count) {
    $stayed = $true
    Write-AdminForgeLog -Level Warn "Something failed, so $me stays an owner of $address to be able to retry"
} elseif (-not $stayed) {
    try { Set-DistributionGroup -Identity $address -ManagedBy @{ Remove = $meAddress } } catch {
        $stayed = $true
        Write-AdminForgeLog -Level Warn "Could not take $me off the owners: $($_.Exception.Message)"
    }
}

Write-AdminForgeProgress -Percent 92 -Message 'Reading it back'
$after = Get-DistributionGroup -Identity $address | Select-Object CustomAttribute15, ManagedBy, RequireSenderAuthenticationEnabled, ExternalDirectoryObjectId
$ownersAfter = @(Get-Owners $after.ManagedBy)
$members = @(Get-DistributionGroupMember -Identity $address -ResultSize Unlimited)
$result = [ordered]@{
    address                   = $address
    displayName               = $displayName
    alias                     = $alias
    externalDirectoryObjectId = [string]$after.ExternalDirectoryObjectId
    created                   = $created
    owners                    = @($ownersAfter | ForEach-Object { $_.address })
    membersAdded              = $added.ToArray()
    memberCount               = $members.Count
    allowExternalSenders      = -not [bool]$after.RequireSenderAuthenticationEnabled
    youAreOwner               = @($ownersAfter | Where-Object { $_.id -eq $meId }).Count -gt 0
    skipped                   = $skipped.ToArray()
    failed                    = $failed.ToArray()
    verified                  = $false
}
$ownerIdsAfter = @($ownersAfter | ForEach-Object { $_.id })
# Not verified while the engineer is still an owner they asked not to stay (taking them off failed).
$result.verified = ([string]$after.CustomAttribute15).StartsWith('AdminForge-created') -and
    @($ownerObjectIds | Where-Object { $ownerIdsAfter -notcontains $_ }).Count -eq 0 -and $result.allowExternalSenders -eq $allowExternal -and
    ($keepMe -or $ownerIdsAfter -notcontains $meId -or $ownerObjectIds -contains $meId)
Write-AdminForgeOutput -Data $result
Write-AdminForgeProgress -Percent 100 -Message 'Done'
if ($failed.Count) {
    $what = ($failed | ForEach-Object { $_.member }) -join ', '
    throw (New-AdminForgeError -Category script -Message "The list is set up, but $($failed.Count) owner or member change$(if ($failed.Count -ne 1) { 's' }) failed ($what). You are still one of its owners: run the playbook again to retry; it adds only what is missing and then takes you off the owners.")
}
