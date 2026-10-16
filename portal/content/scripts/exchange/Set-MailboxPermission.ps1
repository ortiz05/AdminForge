<#
.SYNOPSIS
    Grants or removes Full Access, Send As and/or Send on Behalf on a mailbox for one person or group.

.DESCRIPTION
    Reads the mailbox and the trustee's current explicit (non-inherited) permissions, then adds only what is missing
    or removes only what is there (idempotent). Full Access uses Add-/Remove-MailboxPermission (InheritanceType All;
    AutoMapping on request); Send As uses Add-/Remove-RecipientPermission; Send on Behalf adds or removes the trustee
    in the mailbox's GrantSendOnBehalfTo list (Set-Mailbox -GrantSendOnBehalfTo @{ Add | Remove }). Each change is
    attempted separately and read back. If any change fails the job fails after reporting the result. Inherited
    permissions are never removed. Exchange Online answers "No permissions were found" when the trustee holds none;
    that reads as "not granted".
    The Entra object ids of the mailbox and of the trustee are inputs too, so AdminForge's protected-object guard sees
    who the write is about before it runs; they must equal the ExternalDirectoryObjectId Exchange reports for the
    mailbox and the trustee, otherwise nothing changes. Nobody grants themselves access (Context.User).

.PARAMETER Inputs
    identity          string    Required. Primary SMTP address or UPN of the mailbox.
    mailboxObjectId   string    Required. Entra object id of the mailbox's account (its ExternalDirectoryObjectId).
    trustee           string    Required. UPN or primary SMTP address of the person or mail-enabled security group.
    trusteeObjectId   string    Required. Entra object id of the trustee (its ExternalDirectoryObjectId).
    action            string    Required. add | remove.
    permissions       string[]  Required. FullAccess, SendAs and/or SendOnBehalf.
    autoMapping       bool      Full Access only: add the mailbox to the trustee's Outlook automatically (default true).

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ mailbox; displayName; trustee; action; changed = @(<permission>); skipped = @(@{ permission; reason });
       failed = @(@{ permission; error }); verified }

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
    throw (New-AdminForgeError -Category readOnly -Message 'Changing mailbox permissions changes data; run this script in write mode (armed session).')
}
$smtp = '^[^\s@]+@[^\s@]+\.[^\s@]+$'
$guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern $smtp -MaxLength 320
$mailboxObjectId = Get-AdminForgeInput $Inputs 'mailboxObjectId' -Required -Pattern $guid
$trustee = Get-AdminForgeInput $Inputs 'trustee' -Required -Pattern $smtp -MaxLength 320
$trusteeObjectId = Get-AdminForgeInput $Inputs 'trusteeObjectId' -Required -Pattern $guid
$action = (Get-AdminForgeInput $Inputs 'action' -Required -AllowedValues 'add', 'remove').ToLowerInvariant()
$known = 'FullAccess', 'SendAs', 'SendOnBehalf'
$requested = Get-AdminForgeInput $Inputs 'permissions' -Type StringArray -AllowedValues $known -MaxCount 3
$autoMapping = Get-AdminForgeInput $Inputs 'autoMapping' -Type Bool -Default $true
# Canonical spelling and order, whatever the input's case.
$permissions = @($known | Where-Object { $requested -contains $_ })
if ($permissions.Count -eq 0) {
    throw (New-AdminForgeError -Category input -Message "Input 'permissions' needs FullAccess, SendAs, SendOnBehalf or a combination.")
}

Write-AdminForgeProgress -Percent 5 -Message 'Reading mailbox'
try {
    $mailbox = Get-EXOMailbox -Identity $identity -Properties RecipientTypeDetails | Select-Object DisplayName, PrimarySmtpAddress, UserPrincipalName, ExternalDirectoryObjectId
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = [string]$mailbox.PrimarySmtpAddress
if ([string]$mailbox.ExternalDirectoryObjectId -ine $mailboxObjectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $address doesn't match the mailbox, so nothing was changed. Open the mailbox again and start over.")
}
if ($trustee -ieq $address -or $trustee -ieq [string]$mailbox.UserPrincipalName -or $trusteeObjectId -ieq $mailboxObjectId) {
    throw (New-AdminForgeError -Category input -Message "A mailbox can't be given permissions on itself ($trustee).")
}
try {
    # All in Get-EXORecipient's default (Minimum) property set.
    $trusteeRecipient = Get-EXORecipient -Identity $trustee | Select-Object Name, Alias, PrimarySmtpAddress, ExternalDirectoryObjectId, Guid, Identity
} catch {
    throw (New-AdminForgeError -Category input -Message "'$trustee' is not a recipient in this organization: $($_.Exception.Message)")
}
if ([string]$trusteeRecipient.ExternalDirectoryObjectId -ine $trusteeObjectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $trustee doesn't match that recipient, so nothing was changed. Start over from the mailbox.")
}
$caller = $Context['User']
$callerOid = if ($caller -is [System.Collections.IDictionary] -and $caller['ObjectId']) { [string]$caller['ObjectId'] } else { '' }
$callerUpn = if ($caller -is [System.Collections.IDictionary] -and $caller['Upn']) { [string]$caller['Upn'] } else { '' }
if ($action -eq 'add' -and (($callerOid -and $trusteeObjectId -ieq $callerOid) -or ($callerUpn -and $trustee -ieq $callerUpn))) {
    throw (New-AdminForgeError -Category input -Message "You can't give yourself access to a mailbox. Ask another engineer; nothing was changed.")
}

function Get-Rights($Value) {
    @(@($Value) | ForEach-Object { ([string]$_) -split ',\s*' } | Where-Object { $_ })
}
# Exchange Online answers NotFound ("No permissions were found for the user: …") when the trustee holds none.
function Get-PermissionRows([scriptblock]$Read) {
    try {
        @(& $Read)
    } catch {
        if ([string]$_.Exception.Message -match 'No permissions were found') { return @() }
        throw
    }
}
# Every name Exchange may use for the trustee in GrantSendOnBehalfTo (Name, which is often the Entra object id, alias,
# addresses, ids).
$t = $trusteeRecipient
$trusteeNames = @(@($trustee, $t.Name, $t.Alias, $t.PrimarySmtpAddress, $t.ExternalDirectoryObjectId, $t.Guid, $t.Identity) |
        Where-Object { $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() } | Select-Object -Unique)
# Explicit (non-inherited, allow) grant of one permission to the trustee.
function Test-Granted([string]$Permission) {
    switch ($Permission) {
        'FullAccess' {
            $rows = Get-PermissionRows { Get-EXOMailboxPermission -Identity $address -User $trustee | Select-Object AccessRights, IsInherited, Deny }
            return @($rows | Where-Object { -not $_.IsInherited -and -not $_.Deny -and (Get-Rights $_.AccessRights) -contains 'FullAccess' }).Count -gt 0
        }
        'SendAs' {
            $rows = Get-PermissionRows { Get-EXORecipientPermission -Identity $address -Trustee $trustee | Select-Object AccessRights, AccessControlType, IsInherited }
            return @($rows | Where-Object { -not $_.IsInherited -and [string]$_.AccessControlType -ne 'Deny' -and (Get-Rights $_.AccessRights) -contains 'SendAs' }).Count -gt 0
        }
        default {
            $delegates = @((Get-EXOMailbox -Identity $address -Properties GrantSendOnBehalfTo | Select-Object GrantSendOnBehalfTo).GrantSendOnBehalfTo |
                    Where-Object { $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() })
            if (-not $delegates.Count) { return $false }
            return @($delegates | Where-Object { $trusteeNames -contains $_ }).Count -gt 0
        }
    }
}

$before = @{}
try {
    foreach ($permission in $permissions) { $before[$permission] = Test-Granted $permission }
} catch {
    throw (New-AdminForgeError -Category input -Message "Could not read the permissions of '$trustee' on ${address}: $($_.Exception.Message)")
}

$changed = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[object]]::new()
$failed = [System.Collections.Generic.List[object]]::new()
$step = 0
foreach ($permission in $permissions) {
    $step++
    Write-AdminForgeProgress -Percent (10 + 30 * $step) -Message "$action $permission"
    if ($action -eq 'add' -and $before[$permission]) { $skipped.Add([ordered]@{ permission = $permission; reason = 'already granted' }); continue }
    if ($action -eq 'remove' -and -not $before[$permission]) { $skipped.Add([ordered]@{ permission = $permission; reason = 'not granted directly' }); continue }
    try {
        switch ("$action|$permission") {
            'add|FullAccess' { Add-MailboxPermission -Identity $address -User $trustee -AccessRights FullAccess -InheritanceType All -AutoMapping $autoMapping -Confirm:$false | Out-Null }
            'remove|FullAccess' { Remove-MailboxPermission -Identity $address -User $trustee -AccessRights FullAccess -InheritanceType All -Confirm:$false | Out-Null }
            'add|SendAs' { Add-RecipientPermission -Identity $address -Trustee $trustee -AccessRights SendAs -Confirm:$false | Out-Null }
            'remove|SendAs' { Remove-RecipientPermission -Identity $address -Trustee $trustee -AccessRights SendAs -Confirm:$false | Out-Null }
            'add|SendOnBehalf' { Set-Mailbox -Identity $address -GrantSendOnBehalfTo @{ Add = $trustee } -Confirm:$false | Out-Null }
            'remove|SendOnBehalf' { Set-Mailbox -Identity $address -GrantSendOnBehalfTo @{ Remove = $trustee } -Confirm:$false | Out-Null }
        }
        Write-AdminForgeLog "$(if ($action -eq 'add') { 'Granted' } else { 'Removed' }) $permission for $trustee on $address"
        $changed.Add($permission)
    } catch {
        $failed.Add([ordered]@{ permission = $permission; error = $_.Exception.Message })
        Write-AdminForgeLog -Level Error "Could not $action $permission for ${trustee}: $($_.Exception.Message)"
    }
}

# Read the changes back (they can take a moment to show up).
$verified = $true
if ($changed.Count) {
    $want = $action -eq 'add'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $verified = @($changed | Where-Object { (Test-Granted $_) -ne $want }).Count -eq 0
        if ($verified) { break }
        Start-Sleep -Seconds 3
    }
    if (-not $verified) { Write-AdminForgeLog -Level Warn 'The change was submitted but does not show up yet; check again in a few minutes.' }
}

$result = [ordered]@{
    mailbox     = $address
    displayName = [string]$mailbox.DisplayName
    trustee     = $trustee
    action      = $action
    changed     = $changed.ToArray()
    skipped     = $skipped.ToArray()
    failed      = $failed.ToArray()
    verified    = $verified
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
if ($failed.Count) {
    throw "$($failed.Count) of $($permissions.Count) permission changes failed; see the output for details."
}
