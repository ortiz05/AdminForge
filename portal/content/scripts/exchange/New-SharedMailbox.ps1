<#
.SYNOPSIS
    Creates a shared mailbox, marks it as created by AdminForge, sets whether its account can sign in and grants
    Full Access (and optionally Send As) to the given people.

.DESCRIPTION
    Refuses an address or alias another recipient uses. Every person is checked before anything changes: their
    mailbox must match the Entra object id the playbook resolved (ExternalDirectoryObjectId), be a user mailbox in
    this organization (no guests, contacts or other shared mailboxes) and not belong to the engineer running it.
    A new mailbox is created with New-Mailbox -Shared (Name = alias, which the availability check covers) and marked
    straight away by the id Exchange returns (CustomAttribute15 "AdminForge-created by <engineer> on <date>"), so a
    job that stops later leaves a mailbox AdminForge can still finish or remove. Then it waits until Exchange returns
    the mailbox's account, sets whether that account can sign in (blocked unless allowSignIn — people open a shared
    mailbox through Full Access) and grants each person only what they don't have yet.
    When the address already belongs to a shared mailbox AdminForge created, nothing is created again: existingObjectId
    must name that mailbox, and the run applies the sign-in setting and the permissions (idempotent). Permission
    failures are listed in the output and fail the job afterwards, asking for the playbook to be run again.
    The mark is a guard rail against mistakes, not a security boundary: anyone who can edit custom attributes can set
    it (SECURITY.md → Known gaps), which is why the playbooks ask for the address to be typed.

.PARAMETER Inputs
    displayName         string    Required. Display name, up to 64 characters.
    alias               string    Required. Alias (mail nickname, also the Exchange name): letters, digits, dash,
                                  underscore, and dots between them; up to 64 characters.
    primarySmtpAddress  string    Required. Primary SMTP address in an accepted domain.
    existingObjectId    string    Entra object id of the mailbox when an earlier run created it (required then).
    memberAddresses     string[]  Primary SMTP addresses of the people to give Full Access (up to 50).
    memberObjectIds     string[]  Their Entra object ids, in the same order.
    sendAs              bool      Also grant Send As (default true).
    allowSignIn         bool      Leave the mailbox's account able to sign in (default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ address; displayName; alias; externalDirectoryObjectId; created; accountDisabled; fullAccessAdded;
       sendAsAdded; skipped = @(@{ member; reason }); failed = @(@{ member; permission; error }); verified }

.NOTES
    Tokens: exchange. Mode: write. Exchange role: Mail Recipient Creation and Mail Recipients (Recipient Management).
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Context['Mode'] -ne 'write') {
    throw (New-AdminForgeError -Category readOnly -Message 'Creating a mailbox changes data; run this script in write mode (armed session).')
}
$smtp = '^[^\s@*]+@[^\s@*]+\.[^\s@*]+$'
$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$displayName = Get-AdminForgeInput $Inputs 'displayName' -Required -MaxLength 64 -Pattern '^[^<>;"]{1,64}$'
$alias = Get-AdminForgeInput $Inputs 'alias' -Required -MaxLength 64 -Pattern '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$'
$address = (Get-AdminForgeInput $Inputs 'primarySmtpAddress' -Required -Pattern $smtp -MaxLength 320).ToLowerInvariant()
$existingObjectId = Get-AdminForgeInput $Inputs 'existingObjectId' -Pattern $guid
$memberAddresses = Get-AdminForgeInput $Inputs 'memberAddresses' -Type StringArray -Pattern $smtp -MaxLength 320 -MaxCount 50
$memberObjectIds = Get-AdminForgeInput $Inputs 'memberObjectIds' -Type StringArray -Pattern $guid -MaxCount 50
$sendAs = Get-AdminForgeInput $Inputs 'sendAs' -Type Bool -Default $true
$allowSignIn = Get-AdminForgeInput $Inputs 'allowSignIn' -Type Bool -Default $false
if ($memberAddresses.Count -ne $memberObjectIds.Count) {
    throw (New-AdminForgeError -Category input -Message 'Each member needs both an address and an object id.')
}
$caller = $Context['User']
$callerOid = if ($caller -is [System.Collections.IDictionary] -and $caller['ObjectId']) { [string]$caller['ObjectId'] } else { '' }
$callerUpn = if ($caller -is [System.Collections.IDictionary] -and $caller['Upn']) { [string]$caller['Upn'] } else { '' }
$notYou = "You can't give yourself access to a mailbox. Leave yourself out and ask another engineer to grant it; nothing was changed."
for ($i = 0; $i -lt $memberAddresses.Count; $i++) {
    if (($callerOid -and $memberObjectIds[$i] -ieq $callerOid) -or ($callerUpn -and $memberAddresses[$i] -ieq $callerUpn)) {
        throw (New-AdminForgeError -Category input -Message $notYou)
    }
}

$labels = @{
    UserMailbox = 'a user mailbox'; SharedMailbox = 'a shared mailbox'; RoomMailbox = 'a room mailbox'
    EquipmentMailbox = 'an equipment mailbox'; MailUniversalDistributionGroup = 'a distribution list'
    MailUniversalSecurityGroup = 'a mail-enabled security group'; GroupMailbox = 'a Microsoft 365 group'
    MailUser = 'a mail user'; GuestMailUser = 'a guest'; MailContact = 'a mail contact'
}
function Get-Label([string]$Type) { if ($labels.ContainsKey($Type)) { $labels[$Type] } else { 'another recipient' } }
function Test-NotFound($ErrorRecord) {
    "$($ErrorRecord.Exception.Message) $($ErrorRecord.FullyQualifiedErrorId)" -match "couldn't find object|couldn't be found|ManagementObjectNotFound"
}
# A recipient by identity: $null only when Exchange says nobody uses it; any other failure stops the job.
function Find-Recipient([string]$Identity, [string[]]$Properties = @()) {
    try {
        $found = if ($Properties.Count) { Get-EXORecipient -Identity $Identity -Properties $Properties } else { Get-EXORecipient -Identity $Identity }
        $found | Select-Object PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId, CustomAttribute15
    } catch {
        if (Test-NotFound $_) { return $null }
        if ("$($_.Exception.Message)" -match 'matches multiple entries') {
            throw (New-AdminForgeError -Category input -Message "More than one recipient answers to $Identity, so nothing was changed. Pick another address or alias.")
        }
        Write-AdminForgeLog -Level Warn "Looking up $Identity failed: $($_.Exception.Message)"
        throw (New-AdminForgeError -Category script -Message "Exchange couldn't check $Identity just now, so nothing was changed. Try again in a few minutes.")
    }
}

$domain = $address.Split('@')[1]
$accepted = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() })
if ($accepted -notcontains $domain) {
    throw (New-AdminForgeError -Category input -Message "$domain isn't an accepted domain of this organization. Use one of: $($accepted -join ', ').")
}

Write-AdminForgeProgress -Percent 5 -Message 'Checking the address'
$byAddress = Find-Recipient $address @('CustomAttribute15')
$byAlias = Find-Recipient $alias @('CustomAttribute15')
foreach ($hit in @($byAddress, $byAlias)) {
    if (-not $hit) { continue }
    $ours = ([string]$hit.CustomAttribute15).StartsWith('AdminForge-created') -and [string]$hit.RecipientTypeDetails -eq 'SharedMailbox' -and ([string]$hit.PrimarySmtpAddress).ToLowerInvariant() -eq $address
    if (-not $ours) {
        throw (New-AdminForgeError -Category input -Message "This address or alias is already used by $(Get-Label ([string]$hit.RecipientTypeDetails)) ($($hit.PrimarySmtpAddress)), so nothing was created. Pick another one.")
    }
}
if ($byAddress) {
    if (-not $existingObjectId) {
        throw (New-AdminForgeError -Category input -Message "$address already exists (AdminForge created it). Start the playbook again so it can check that mailbox; nothing was changed.")
    }
    if ([string]$byAddress.ExternalDirectoryObjectId -ine $existingObjectId) {
        throw (New-AdminForgeError -Category input -Message "The mailbox given for $address doesn't match the one in Exchange, so nothing was changed. Start the playbook again.")
    }
} elseif ($existingObjectId) {
    throw (New-AdminForgeError -Category input -Message "$address no longer exists, so there is nothing to finish. Run the playbook again to create it.")
}

# Every person is checked before anything changes.
Write-AdminForgeProgress -Percent 10 -Message 'Checking the people'
$members = [System.Collections.Generic.List[string]]::new()
for ($i = 0; $i -lt $memberAddresses.Count; $i++) {
    $member = $memberAddresses[$i].ToLowerInvariant()
    $recipient = Find-Recipient $member
    if (-not $recipient) {
        throw (New-AdminForgeError -Category input -Message "No mailbox uses $member, so nothing was changed.")
    }
    $id = [string]$recipient.ExternalDirectoryObjectId
    if ($id -ine $memberObjectIds[$i]) {
        throw (New-AdminForgeError -Category input -Message "The account given for $member doesn't match its mailbox, so nothing was changed. Start the playbook again.")
    }
    if ([string]$recipient.RecipientTypeDetails -ne 'UserMailbox') {
        throw (New-AdminForgeError -Category input -Message "$member is $(Get-Label ([string]$recipient.RecipientTypeDetails)). Mailbox access can only be given to people with a mailbox in your organization; nothing was changed.")
    }
    if ($callerOid -and $id -ieq $callerOid) { throw (New-AdminForgeError -Category input -Message $notYou) }
    if ($existingObjectId -and $id -ieq $existingObjectId) {
        throw (New-AdminForgeError -Category input -Message "A mailbox can't be given permissions on itself; nothing was changed.")
    }
    $members.Add([string]$recipient.PrimarySmtpAddress)
}

$by = if ($callerUpn) { $callerUpn } else { 'an engineer' }
$marker = "AdminForge-created by $by on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))"
$created = $false
if (-not $byAddress) {
    Write-AdminForgeProgress -Percent 20 -Message 'Creating the shared mailbox'
    Write-AdminForgeLog "Creating shared mailbox $address ($displayName)"
    $new = New-Mailbox -Shared -Name $alias -DisplayName $displayName -Alias $alias -PrimarySmtpAddress $address | Select-Object Guid
    $created = $true
    # Mark it straight away, by the id Exchange returned: an unmarked mailbox could be neither finished nor removed
    # by AdminForge if the job stopped now.
    $exchangeId = if ([string]$new.Guid) { [string]$new.Guid } else { $address }
    $marked = $false
    for ($attempt = 1; $attempt -le 6 -and -not $marked; $attempt++) {
        try {
            Set-Mailbox -Identity $exchangeId -CustomAttribute15 $marker
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
    Write-AdminForgeLog "$address was created by AdminForge before; applying its sign-in setting and permissions"
}

# A new mailbox's account can take a moment to appear; read it back a few times.
$mailbox = $null
for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
        $mailbox = Get-EXOMailbox -Identity $address -Properties RecipientTypeDetails, CustomAttribute15, AccountDisabled |
            Select-Object DisplayName, PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId, CustomAttribute15, AccountDisabled
        if ($mailbox -and [string]$mailbox.ExternalDirectoryObjectId) { break }
    } catch { $mailbox = $null }
    $mailbox = $null
    Write-AdminForgeProgress -Percent (25 + 2 * $attempt) -Message "Waiting for Exchange ($attempt)"
    Start-Sleep -Seconds 10
}
if (-not $mailbox) {
    throw (New-AdminForgeError -Category script -Message "Exchange created $address and it is marked as created by AdminForge, but its account isn't ready yet. Run the playbook again in a few minutes; it finishes this mailbox.")
}

Write-AdminForgeProgress -Percent 55 -Message 'Setting sign-in'
$settings = @{ Identity = $address; AccountDisabled = (-not $allowSignIn) }
if (-not ([string]$mailbox.CustomAttribute15).StartsWith('AdminForge-created')) { $settings.CustomAttribute15 = $marker }
Set-Mailbox @settings

$fullAccess = [System.Collections.Generic.List[string]]::new()
$sendAsAdded = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[object]]::new()
$failed = [System.Collections.Generic.List[object]]::new()
$n = 0
foreach ($member in $members) {
    $n++
    Write-AdminForgeProgress -Percent (60 + [Math]::Floor(30 * $n / [Math]::Max(1, $members.Count))) -Message "Granting $member"
    # Exchange answers "no permissions found" with an error when the person holds none.
    $hasFull = $false
    try {
        $hasFull = @(Get-EXOMailboxPermission -Identity $address -User $member | Where-Object { -not $_.IsInherited -and $_.AccessRights -contains 'FullAccess' }).Count -gt 0
    } catch { $hasFull = $false }
    if ($hasFull) { $skipped.Add([ordered]@{ member = $member; reason = 'already has Full Access' }) }
    else {
        try {
            Add-MailboxPermission -Identity $address -User $member -AccessRights FullAccess -InheritanceType All -AutoMapping $true -Confirm:$false | Out-Null
            $fullAccess.Add($member)
        } catch {
            $failed.Add([ordered]@{ member = $member; permission = 'Full Access'; error = $_.Exception.Message })
        }
    }
    if (-not $sendAs) { continue }
    $hasSendAs = $false
    try {
        $hasSendAs = @(Get-EXORecipientPermission -Identity $address -Trustee $member | Where-Object { $_.AccessRights -contains 'SendAs' }).Count -gt 0
    } catch { $hasSendAs = $false }
    if ($hasSendAs) { $skipped.Add([ordered]@{ member = $member; reason = 'already has Send As' }); continue }
    try {
        Add-RecipientPermission -Identity $address -Trustee $member -AccessRights SendAs -Confirm:$false | Out-Null
        $sendAsAdded.Add($member)
    } catch {
        $failed.Add([ordered]@{ member = $member; permission = 'Send As'; error = $_.Exception.Message })
    }
}

Write-AdminForgeProgress -Percent 95 -Message 'Reading it back'
$after = Get-EXOMailbox -Identity $address -Properties RecipientTypeDetails, CustomAttribute15, AccountDisabled |
    Select-Object RecipientTypeDetails, CustomAttribute15, AccountDisabled
$result = [ordered]@{
    address                   = $address
    displayName               = $displayName
    alias                     = $alias
    externalDirectoryObjectId = [string]$mailbox.ExternalDirectoryObjectId
    created                   = $created
    accountDisabled           = [bool]$after.AccountDisabled
    fullAccessAdded           = $fullAccess.ToArray()
    sendAsAdded               = $sendAsAdded.ToArray()
    skipped                   = $skipped.ToArray()
    failed                    = $failed.ToArray()
    verified                  = $false
}
$result.verified = [string]$after.RecipientTypeDetails -eq 'SharedMailbox' -and ([string]$after.CustomAttribute15).StartsWith('AdminForge-created') -and ($result.accountDisabled -eq (-not $allowSignIn))

Write-AdminForgeOutput -Data $result
Write-AdminForgeProgress -Percent 100 -Message 'Done'
if ($failed.Count) {
    $what = ($failed | ForEach-Object { "$($_.permission) for $($_.member)" }) -join ', '
    throw (New-AdminForgeError -Category script -Message "The mailbox is set up, but $($failed.Count) permission change$(if ($failed.Count -ne 1) { 's' }) failed ($what). Run the playbook again to retry; it only grants what is still missing.")
}
