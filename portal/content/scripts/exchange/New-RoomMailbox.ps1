<#
.SYNOPSIS
    Creates a room mailbox, marks it as created by AdminForge and sets its booking options.

.DESCRIPTION
    Refuses an address or alias another recipient uses. A new room is created with New-Mailbox -Room (its account
    can't sign in; Name = alias, which the availability check covers) and marked straight away by the id Exchange
    returns (CustomAttribute15 "AdminForge-created by <engineer> on <date>"), so a job that stops later leaves a room
    AdminForge can still finish or remove. Then it waits until Exchange returns the room's account, sets its capacity
    (Set-Mailbox -ResourceCapacity, only when given) and its booking options (Set-CalendarProcessing), and reads them
    back. When the address already belongs to a room AdminForge created, nothing is created again: existingObjectId
    must name that room, and the run applies the capacity and booking options again (idempotent).
    The mark is a guard rail against mistakes, not a security boundary: anyone who can edit custom attributes can set
    it (SECURITY.md → Known gaps), which is why the playbooks ask for the address to be typed.

.PARAMETER Inputs
    displayName           string  Required. Display name, up to 64 characters.
    alias                 string  Required. Alias (mail nickname, also the Exchange name): letters, digits, dash,
                                  underscore, and dots between them; up to 64 characters.
    primarySmtpAddress    string  Required. Primary SMTP address in an accepted domain.
    existingObjectId      string  Entra object id of the room when an earlier run created it (required then).
    capacity              int     Seats (0–10000; 0 = leave as it is).
    autoAccept            bool    Accept or decline invitations automatically (default true).
    allowConflicts        bool    Allow overlapping bookings (default false).
    bookingWindowInDays   int     How far ahead it can be booked (1–1080, default 180).
    maximumDurationHours  int     Longest booking in hours (1–24, default 24).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ address; displayName; alias; externalDirectoryObjectId; created; capacity; automateProcessing;
       allowConflicts; bookingWindowInDays; maximumDurationInMinutes; verified }

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
$displayName = Get-AdminForgeInput $Inputs 'displayName' -Required -MaxLength 64 -Pattern '^[^<>;"]{1,64}$'
$alias = Get-AdminForgeInput $Inputs 'alias' -Required -MaxLength 64 -Pattern '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$'
$address = (Get-AdminForgeInput $Inputs 'primarySmtpAddress' -Required -Pattern '^[^\s@*]+@[^\s@*]+\.[^\s@*]+$' -MaxLength 320).ToLowerInvariant()
$existingObjectId = Get-AdminForgeInput $Inputs 'existingObjectId' -Pattern '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$capacity = Get-AdminForgeInput $Inputs 'capacity' -Type Int -Default 0 -Minimum 0 -Maximum 10000
$autoAccept = Get-AdminForgeInput $Inputs 'autoAccept' -Type Bool -Default $true
$allowConflicts = Get-AdminForgeInput $Inputs 'allowConflicts' -Type Bool -Default $false
$window = Get-AdminForgeInput $Inputs 'bookingWindowInDays' -Type Int -Default 180 -Minimum 1 -Maximum 1080
$maxHours = Get-AdminForgeInput $Inputs 'maximumDurationHours' -Type Int -Default 24 -Minimum 1 -Maximum 24

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

$domain = $address.Split('@')[1]
$accepted = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() })
if ($accepted -notcontains $domain) {
    throw (New-AdminForgeError -Category input -Message "$domain isn't an accepted domain of this organization. Use one of: $($accepted -join ', ').")
}

Write-AdminForgeProgress -Percent 5 -Message 'Checking the address'
$byAddress = Find-Recipient $address
$byAlias = Find-Recipient $alias
foreach ($hit in @($byAddress, $byAlias)) {
    if (-not $hit) { continue }
    $ours = ([string]$hit.CustomAttribute15).StartsWith('AdminForge-created') -and [string]$hit.RecipientTypeDetails -eq 'RoomMailbox' -and ([string]$hit.PrimarySmtpAddress).ToLowerInvariant() -eq $address
    if (-not $ours) {
        throw (New-AdminForgeError -Category input -Message "This address or alias is already used by $(Get-Label ([string]$hit.RecipientTypeDetails)) ($($hit.PrimarySmtpAddress)), so nothing was created. Pick another one.")
    }
}
if ($byAddress) {
    if (-not $existingObjectId) {
        throw (New-AdminForgeError -Category input -Message "$address already exists (AdminForge created it). Start the playbook again so it can check that room; nothing was changed.")
    }
    if ([string]$byAddress.ExternalDirectoryObjectId -ine $existingObjectId) {
        throw (New-AdminForgeError -Category input -Message "The room given for $address doesn't match the one in Exchange, so nothing was changed. Start the playbook again.")
    }
} elseif ($existingObjectId) {
    throw (New-AdminForgeError -Category input -Message "$address no longer exists, so there is nothing to finish. Run the playbook again to create it.")
}

$by = if ($Context['User'] -is [System.Collections.IDictionary] -and $Context['User']['Upn']) { [string]$Context['User']['Upn'] } else { 'an engineer' }
$marker = "AdminForge-created by $by on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))"
$created = $false
if (-not $byAddress) {
    Write-AdminForgeProgress -Percent 20 -Message 'Creating the room'
    Write-AdminForgeLog "Creating room mailbox $address ($displayName)"
    $new = New-Mailbox -Room -Name $alias -DisplayName $displayName -Alias $alias -PrimarySmtpAddress $address | Select-Object Guid
    $created = $true
    # Mark it straight away, by the id Exchange returned: an unmarked room could be neither finished nor removed by
    # AdminForge if the job stopped now.
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
    Write-AdminForgeLog "$address was created by AdminForge before; applying its capacity and booking options"
}

$mailbox = $null
for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
        $mailbox = Get-EXOMailbox -Identity $address -Properties RecipientTypeDetails, CustomAttribute15 |
            Select-Object PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId, CustomAttribute15
        if ($mailbox -and [string]$mailbox.ExternalDirectoryObjectId) { break }
    } catch { $mailbox = $null }
    $mailbox = $null
    Write-AdminForgeProgress -Percent (25 + 2 * $attempt) -Message "Waiting for Exchange ($attempt)"
    Start-Sleep -Seconds 10
}
if (-not $mailbox) {
    throw (New-AdminForgeError -Category script -Message "Exchange created the room $address and it is marked as created by AdminForge, but its account isn't ready yet. Run the playbook again in a few minutes; it finishes this room.")
}

Write-AdminForgeProgress -Percent 60 -Message 'Setting capacity'
$settings = @{ Identity = $address }
if (-not ([string]$mailbox.CustomAttribute15).StartsWith('AdminForge-created')) { $settings.CustomAttribute15 = $marker }
if ($capacity -gt 0) { $settings.ResourceCapacity = $capacity }
if ($settings.Count -gt 1) { Set-Mailbox @settings }

Write-AdminForgeProgress -Percent 75 -Message 'Setting booking options'
$processing = if ($autoAccept) { 'AutoAccept' } else { 'AutoUpdate' }
Set-CalendarProcessing -Identity $address -AutomateProcessing $processing -AllowConflicts $allowConflicts `
    -BookingWindowInDays $window -MaximumDurationInMinutes ($maxHours * 60) -Confirm:$false

Write-AdminForgeProgress -Percent 90 -Message 'Reading it back'
$cal = Get-CalendarProcessing -Identity $address | Select-Object AutomateProcessing, AllowConflicts, BookingWindowInDays, MaximumDurationInMinutes
$after = Get-EXOMailbox -Identity $address -Properties RecipientTypeDetails, CustomAttribute15, ResourceCapacity |
    Select-Object RecipientTypeDetails, CustomAttribute15, ResourceCapacity
$result = [ordered]@{
    address                   = $address
    displayName               = $displayName
    alias                     = $alias
    externalDirectoryObjectId = [string]$mailbox.ExternalDirectoryObjectId
    created                   = $created
    capacity                  = if ($null -eq $after.ResourceCapacity) { $null } else { [int]$after.ResourceCapacity }
    automateProcessing        = [string]$cal.AutomateProcessing
    allowConflicts            = [bool]$cal.AllowConflicts
    bookingWindowInDays       = [int]$cal.BookingWindowInDays
    maximumDurationInMinutes  = [int]$cal.MaximumDurationInMinutes
    verified                  = $false
}
$result.verified = [string]$after.RecipientTypeDetails -eq 'RoomMailbox' -and ([string]$after.CustomAttribute15).StartsWith('AdminForge-created') -and
    $result.automateProcessing -eq $processing -and $result.allowConflicts -eq $allowConflicts -and
    $result.bookingWindowInDays -eq $window -and $result.maximumDurationInMinutes -eq ($maxHours * 60) -and
    ($capacity -eq 0 -or $result.capacity -eq $capacity)
Write-AdminForgeOutput -Data $result
Write-AdminForgeProgress -Percent 100 -Message 'Done'
