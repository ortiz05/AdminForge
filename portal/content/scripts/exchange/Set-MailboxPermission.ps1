<#
.SYNOPSIS
    Grants or removes Full Access and/or Send As on a mailbox for one person or group.

.DESCRIPTION
    Reads the mailbox and the trustee's current explicit (non-inherited) permissions, then adds only what is missing
    or removes only what is there (idempotent). Full Access uses Add-/Remove-MailboxPermission (InheritanceType All;
    AutoMapping on request); Send As uses Add-/Remove-RecipientPermission. Each change is attempted separately and
    read back. If any change fails the job fails after reporting the result. Inherited permissions are never removed.

.PARAMETER Inputs
    identity      string    Required. Primary SMTP address or UPN of the mailbox.
    trustee       string    Required. UPN or primary SMTP address of the person or mail-enabled security group.
    action        string    Required. add | remove.
    permissions   string[]  Required. FullAccess and/or SendAs.
    autoMapping   bool      Full Access only: add the mailbox to the trustee's Outlook automatically (default true).

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
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern $smtp -MaxLength 320
$trustee = Get-AdminForgeInput $Inputs 'trustee' -Required -Pattern $smtp -MaxLength 320
$action = (Get-AdminForgeInput $Inputs 'action' -Required -AllowedValues 'add', 'remove').ToLowerInvariant()
$requested = Get-AdminForgeInput $Inputs 'permissions' -Type StringArray -AllowedValues 'FullAccess', 'SendAs' -MaxCount 2
$autoMapping = Get-AdminForgeInput $Inputs 'autoMapping' -Type Bool -Default $true
$permissions = @($requested | ForEach-Object { if ($_ -eq 'FullAccess') { 'FullAccess' } else { 'SendAs' } } | Select-Object -Unique)
if ($permissions.Count -eq 0) {
    throw (New-AdminForgeError -Category input -Message "Input 'permissions' needs FullAccess, SendAs or both.")
}

Write-AdminForgeProgress -Percent 5 -Message 'Reading mailbox'
try {
    $mailbox = Get-EXOMailbox -Identity $identity -Properties RecipientTypeDetails | Select-Object DisplayName, PrimarySmtpAddress, UserPrincipalName
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = [string]$mailbox.PrimarySmtpAddress
if ($trustee -ieq $address -or $trustee -ieq [string]$mailbox.UserPrincipalName) {
    throw (New-AdminForgeError -Category input -Message "A mailbox can't be given permissions on itself ($trustee).")
}

function Get-Rights($Value) {
    @(@($Value) | ForEach-Object { ([string]$_) -split ',\s*' } | Where-Object { $_ })
}
# Explicit (non-inherited, allow) grant of one permission to the trustee.
function Test-Granted([string]$Permission) {
    if ($Permission -eq 'FullAccess') {
        $rows = @(Get-EXOMailboxPermission -Identity $address -User $trustee | Select-Object AccessRights, IsInherited, Deny)
        return @($rows | Where-Object { -not $_.IsInherited -and -not $_.Deny -and (Get-Rights $_.AccessRights) -contains 'FullAccess' }).Count -gt 0
    }
    $rows = @(Get-EXORecipientPermission -Identity $address -Trustee $trustee | Select-Object AccessRights, AccessControlType, IsInherited)
    @($rows | Where-Object { -not $_.IsInherited -and [string]$_.AccessControlType -ne 'Deny' -and (Get-Rights $_.AccessRights) -contains 'SendAs' }).Count -gt 0
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
