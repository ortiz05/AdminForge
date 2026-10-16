<#
.SYNOPSIS
    Forwards a mailbox's mail to a user or shared mailbox inside the organization (mailbox-level ForwardingAddress).

.DESCRIPTION
    Forwarding is how mail leaves a mailbox unseen, so the target is checked here whatever the playbook checked:
      - it must be a UserMailbox or SharedMailbox in Exchange Online. Groups are refused (a group can contain guests
        and mail contacts, so mail would leak outside), and so are mail users (a hybrid mailbox still on-premises, or an
        address in another organization), mail contacts, guests, room and equipment mailboxes;
      - it must not forward mail itself (ForwardingSmtpAddress or ForwardingAddress set), or the mail travels on;
      - it must not be the mailbox itself, nor the person running the script (Context.User).
    The Entra object ids of the mailbox and of the target are inputs too, so AdminForge's protected-object guard sees
    who the write is about before it runs; both must equal the recipients' ExternalDirectoryObjectId here, otherwise
    nothing changes. Refuses a mailbox that already forwards (to an address or a recipient) so an existing forwarding
    is never silently replaced; clear it first. Sets ForwardingAddress and DeliverToMailboxAndForward with one
    Set-Mailbox call and reads them back (retried for about 10 seconds). Undo with Clear-MailboxForwarding.ps1.

.PARAMETER Inputs
    identity                     string  Required. Primary SMTP address or UPN of the mailbox.
    mailboxObjectId              string  Required. Entra object id of the mailbox's account (its ExternalDirectoryObjectId).
    target                       string  Required. Email address of the user or shared mailbox that receives the mail.
    targetObjectId               string  Required. Entra object id of the target's account (its ExternalDirectoryObjectId).
    deliverToMailboxAndForward   bool    Keep a copy in the mailbox as well (default true).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ identity; displayName; primarySmtpAddress; target = @{ address; displayName; recipientTypeDetails };
       before = @{ forwardingSmtpAddress; forwardingAddress; deliverToMailboxAndForward }; after = @{ … };
       changed; verified }

.NOTES
    Tokens: exchange. Mode: write. Exchange role: Mail Recipients (Recipient Management) or higher.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Context['Mode'] -ne 'write') {
    throw (New-AdminForgeError -Category readOnly -Message 'Forwarding a mailbox changes data; run this script in write mode (armed session).')
}
$smtp = '^[^\s@]+@[^\s@]+\.[^\s@]+$'
$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern $smtp -MaxLength 320
$mailboxObjectId = Get-AdminForgeInput $Inputs 'mailboxObjectId' -Required -Pattern $guid
$targetInput = Get-AdminForgeInput $Inputs 'target' -Required -Pattern $smtp -MaxLength 320
$targetObjectId = Get-AdminForgeInput $Inputs 'targetObjectId' -Required -Pattern $guid
$keepCopy = Get-AdminForgeInput $Inputs 'deliverToMailboxAndForward' -Type Bool -Default $true

# Only mailboxes of people and shared mailboxes receive forwarded mail here.
$allowedTypes = 'UserMailbox', 'SharedMailbox'
$groupTypes = 'MailUniversalDistributionGroup', 'MailUniversalSecurityGroup', 'MailNonUniversalGroup', 'DynamicDistributionGroup',
'GroupMailbox', 'RoomList'
$caller = $Context['User']
$callerOid = if ($caller -is [System.Collections.IDictionary] -and $caller['ObjectId']) { [string]$caller['ObjectId'] } else { '' }
$callerUpn = if ($caller -is [System.Collections.IDictionary] -and $caller['Upn']) { [string]$caller['Upn'] } else { '' }

function Read-Forwarding([string]$Id) {
    $m = Get-EXOMailbox -Identity $Id -Properties RecipientTypeDetails, ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward |
        Select-Object DisplayName, PrimarySmtpAddress, UserPrincipalName, ExternalDirectoryObjectId, RecipientTypeDetails,
        ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward
    [ordered]@{
        displayName                = [string]$m.DisplayName
        primarySmtpAddress         = [string]$m.PrimarySmtpAddress
        userPrincipalName          = [string]$m.UserPrincipalName
        objectId                   = [string]$m.ExternalDirectoryObjectId
        recipientTypeDetails       = [string]$m.RecipientTypeDetails
        forwardingSmtpAddress      = if ($m.ForwardingSmtpAddress) { ([string]$m.ForwardingSmtpAddress) -replace '^smtp:', '' } else { $null }
        forwardingAddress          = if ($m.ForwardingAddress) { [string]$m.ForwardingAddress } else { $null }
        deliverToMailboxAndForward = [bool]$m.DeliverToMailboxAndForward
    }
}
$state = { param($f) [ordered]@{ forwardingSmtpAddress = $f.forwardingSmtpAddress; forwardingAddress = $f.forwardingAddress; deliverToMailboxAndForward = $f.deliverToMailboxAndForward } }
# ForwardingAddress holds the recipient's Name (often its Entra object id); compare by the recipient's address.
function Get-ForwardingTarget($Forwarding) {
    if (-not $Forwarding.forwardingAddress) { return $null }
    try {
        [string](Get-EXORecipient -Identity $Forwarding.forwardingAddress | Select-Object -ExpandProperty PrimarySmtpAddress)
    } catch {
        $Forwarding.forwardingAddress
    }
}

Write-AdminForgeProgress -Percent 10 -Message 'Reading mailbox'
try {
    $before = Read-Forwarding $identity
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = $before.primarySmtpAddress
if ($before.objectId -ine $mailboxObjectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $address doesn't match the mailbox, so nothing was changed. Open the mailbox again and start over.")
}

Write-AdminForgeProgress -Percent 20 -Message 'Checking the target'
try {
    $target = Get-EXORecipient -Identity $targetInput | Select-Object DisplayName, PrimarySmtpAddress, RecipientTypeDetails, ExternalDirectoryObjectId
} catch {
    throw (New-AdminForgeError -Category input -Message "'$targetInput' is not a recipient in this organization. Forward to the primary address of a user or shared mailbox here.")
}
$targetAddress = [string]$target.PrimarySmtpAddress
$targetType = [string]$target.RecipientTypeDetails
if ($targetType -notin $allowedTypes) {
    $why = if ($targetType -eq 'MailUser') {
        "is a mail user: its mailbox isn't in Exchange Online (for example still on-premises in a hybrid setup, or in another organization)"
    } elseif ($targetType -in $groupTypes) {
        'is a group, and a group can include guests and contacts outside the organization'
    } elseif ($targetType -in 'MailContact', 'GuestMailUser') {
        "is outside the organization ($targetType)"
    } else {
        "is a $targetType, not a user or shared mailbox"
    }
    throw (New-AdminForgeError -Category input -Message "'$targetInput' $why. Forward to a user or shared mailbox in Exchange Online instead; nothing was changed.")
}
if ([string]$target.ExternalDirectoryObjectId -ine $targetObjectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $targetAddress doesn't match that mailbox, so nothing was changed. Start over from the mailbox.")
}
if ($targetAddress -ieq $address -or $targetInput -ieq $before.userPrincipalName -or $targetObjectId -ieq $mailboxObjectId) {
    throw (New-AdminForgeError -Category input -Message "A mailbox can't forward to itself ($targetInput). Pick the person or shared mailbox that should receive the mail.")
}
if (($callerOid -and $targetObjectId -ieq $callerOid) -or ($callerUpn -and ($targetInput -ieq $callerUpn -or $targetAddress -ieq $callerUpn))) {
    throw (New-AdminForgeError -Category input -Message "You can't forward a mailbox's mail to yourself. Ask another engineer to set it up; nothing was changed.")
}

Write-AdminForgeProgress -Percent 30 -Message 'Checking that the target keeps the mail'
$targetMailbox = Read-Forwarding $targetAddress
if ($targetMailbox.forwardingSmtpAddress -or $targetMailbox.forwardingAddress) {
    $onward = @($targetMailbox.forwardingSmtpAddress, (Get-ForwardingTarget $targetMailbox)) | Where-Object { $_ } | Select-Object -First 1
    throw (New-AdminForgeError -Category input -Message "$targetAddress forwards its own mail to $onward, so the mail would travel on from there. Pick another mailbox, or clear that mailbox's forwarding first; nothing was changed.")
}

$result = [ordered]@{
    identity           = $identity
    displayName        = $before.displayName
    primarySmtpAddress = $address
    target             = [ordered]@{ address = $targetAddress; displayName = [string]$target.DisplayName; recipientTypeDetails = $targetType }
    before             = & $state $before
    after              = & $state $before
    changed            = $false
    verified           = $false
}

$current = Get-ForwardingTarget $before
if ($before.forwardingSmtpAddress -or ($current -and $current -ine $targetAddress)) {
    $existing = @($before.forwardingSmtpAddress, $current) | Where-Object { $_ } | Select-Object -First 1
    throw (New-AdminForgeError -Category input -Message "$address already forwards to $existing. Clear that forwarding first (Clear forwarding on the mailbox), so it isn't replaced by accident.")
}
if ($current -and $before.deliverToMailboxAndForward -eq $keepCopy) {
    Write-AdminForgeLog "$address already forwards to $targetAddress; nothing to do"
    $result.verified = $true
    Write-AdminForgeProgress -Percent 100 -Message 'Nothing to change'
    Write-AdminForgeOutput -Data $result
    return
}

Write-AdminForgeProgress -Percent 40 -Message 'Setting forwarding'
Write-AdminForgeLog "Forwarding $address to $targetAddress ($targetType), keep a copy: $keepCopy"
Set-Mailbox -Identity $address -ForwardingAddress $targetAddress -DeliverToMailboxAndForward $keepCopy
$result.changed = $true

for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-AdminForgeProgress -Percent (50 + 15 * $attempt) -Message "Verifying ($attempt)"
    $after = Read-Forwarding $address
    $result.after = & $state $after
    if ((Get-ForwardingTarget $after) -ieq $targetAddress -and $after.deliverToMailboxAndForward -eq $keepCopy) { $result.verified = $true; break }
    Start-Sleep -Seconds 3
}
if (-not $result.verified) { Write-AdminForgeLog -Level Warn "The change was submitted but $address doesn't show it yet; check the mailbox again in a few minutes" }

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
