<#
.SYNOPSIS
    Who can open, send as, or send on behalf of one mailbox (Full Access, Send As, Send on Behalf).

.DESCRIPTION
    Reads the mailbox (Get-EXOMailbox), its Full Access permissions (Get-EXOMailboxPermission), its Send As
    permissions (Get-EXORecipientPermission) and its GrantSendOnBehalfTo list. The mailbox's own SELF entry and
    built-in system accounts (NT AUTHORITY\*, well-known S-1-5 SIDs) are left out. Inherited entries are kept and
    flagged (they are granted at the organization or database level and can't be removed per mailbox); entries that
    point at a deleted account show as a SID and are flagged as orphaned. Trustees are resolved to a display name,
    primary address and recipient type with Get-EXORecipient (at most 50 lookups). Send on Behalf entries are listed by
    their address once resolved, so they can be removed like the others.

.PARAMETER Inputs
    identity   string  Required. Primary SMTP address or UPN of the mailbox.

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ mailbox = @{ displayName; primarySmtpAddress; userPrincipalName; recipientTypeDetails };
       summary = @{ fullAccess; sendAs; sendOnBehalf; total; inherited; orphaned };
       permissions = @(@{ key; permission = 'FullAccess'|'SendAs'|'SendOnBehalf'; trustee; trusteeDisplayName;
                         trusteeAddress; trusteeType; accessRights; inherited; deny; orphaned; removable }) }

.NOTES
    Tokens: exchange. Mode: read. Exchange role: View-Only Recipients (or higher).
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$smtp = '^[^\s@]+@[^\s@]+\.[^\s@]+$'
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern $smtp -MaxLength 320

Write-AdminForgeProgress -Percent 5 -Message 'Reading mailbox'
try {
    $mailbox = Get-EXOMailbox -Identity $identity -Properties RecipientTypeDetails, GrantSendOnBehalfTo |
        Select-Object DisplayName, PrimarySmtpAddress, UserPrincipalName, RecipientTypeDetails, GrantSendOnBehalfTo
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = [string]$mailbox.PrimarySmtpAddress

# Built-in principals are noise here; S-1-5-21-… SIDs are deleted accounts and are worth showing.
function Test-SystemTrustee([string]$Name) {
    $Name -match '^(NT AUTHORITY\\|NT-AUTORIT|S-1-5-(?!21-))' -or $Name -eq ''
}
function Get-Rights($Value) {
    @(@($Value) | ForEach-Object { ([string]$_) -split ',\s*' } | Where-Object { $_ })
}

$entries = [System.Collections.Generic.List[object]]::new()

Write-AdminForgeProgress -Percent 25 -Message 'Reading Full Access permissions'
foreach ($p in @(Get-EXOMailboxPermission -Identity $address | Select-Object User, AccessRights, IsInherited, Deny)) {
    $user = [string]$p.User
    $rights = Get-Rights $p.AccessRights
    if ((Test-SystemTrustee $user) -or $rights -notcontains 'FullAccess') { continue }
    $entries.Add([ordered]@{ permission = 'FullAccess'; trustee = $user; accessRights = $rights; inherited = [bool]$p.IsInherited; deny = [bool]$p.Deny })
}

Write-AdminForgeProgress -Percent 50 -Message 'Reading Send As permissions'
foreach ($p in @(Get-EXORecipientPermission -Identity $address | Select-Object Trustee, AccessRights, AccessControlType, IsInherited)) {
    $trustee = [string]$p.Trustee
    $rights = Get-Rights $p.AccessRights
    if ((Test-SystemTrustee $trustee) -or $rights -notcontains 'SendAs') { continue }
    $entries.Add([ordered]@{ permission = 'SendAs'; trustee = $trustee; accessRights = $rights; inherited = [bool]$p.IsInherited; deny = ([string]$p.AccessControlType -eq 'Deny') })
}

foreach ($delegate in @($mailbox.GrantSendOnBehalfTo | Where-Object { $_ })) {
    $entries.Add([ordered]@{ permission = 'SendOnBehalf'; trustee = [string]$delegate; accessRights = @('SendOnBehalf'); inherited = $false; deny = $false })
}

Write-AdminForgeProgress -Percent 70 -Message 'Resolving people and groups'
$resolved = @{}
$lookups = 0
foreach ($name in @($entries | ForEach-Object { $_.trustee } | Select-Object -Unique)) {
    if ($name -match '^S-1-5-21-') { continue }
    if ($lookups -ge 50) { Write-AdminForgeLog -Level Warn 'Stopped resolving trustees after 50 lookups'; break }
    $lookups++
    try {
        $r = Get-EXORecipient -Identity $name -Properties RecipientTypeDetails | Select-Object DisplayName, PrimarySmtpAddress, RecipientTypeDetails
        $resolved[$name] = $r
    } catch {
        Write-AdminForgeLog -Level Warn "Could not resolve trustee ${name}: $($_.Exception.Message)"
    }
}

$permissions = @($entries | ForEach-Object {
        $e = $_
        $r = if ($resolved.ContainsKey($e.trustee)) { $resolved[$e.trustee] } else { $null }
        # Send on Behalf lists recipients by name; show their address so the row can be acted on.
        $trustee = if ($e.permission -eq 'SendOnBehalf' -and $r -and $r.PrimarySmtpAddress) { [string]$r.PrimarySmtpAddress } else { $e.trustee }
        $orphaned = $trustee -match '^S-1-5-21-'
        [ordered]@{
            key                = "$($e.permission)|$trustee".ToLowerInvariant()
            permission         = $e.permission
            trustee            = $trustee
            trusteeDisplayName = if ($r) { [string]$r.DisplayName } else { $null }
            trusteeAddress     = if ($r -and $r.PrimarySmtpAddress) { [string]$r.PrimarySmtpAddress } else { $null }
            trusteeType        = if ($r) { [string]$r.RecipientTypeDetails } else { $null }
            accessRights       = @($e.accessRights)  # a one-right list would otherwise serialize as a string
            inherited          = $e.inherited
            deny               = $e.deny
            orphaned           = $orphaned
            removable          = -not $e.inherited -and -not $e.deny -and ($trustee -match $smtp)
        }
    })

$granted = @($permissions | Where-Object { -not $_.deny })
$result = [ordered]@{
    mailbox     = [ordered]@{
        displayName          = [string]$mailbox.DisplayName
        primarySmtpAddress   = $address
        userPrincipalName    = [string]$mailbox.UserPrincipalName
        recipientTypeDetails = [string]$mailbox.RecipientTypeDetails
    }
    summary     = [ordered]@{
        fullAccess   = @($granted | Where-Object { $_.permission -eq 'FullAccess' }).Count
        sendAs       = @($granted | Where-Object { $_.permission -eq 'SendAs' }).Count
        sendOnBehalf = @($granted | Where-Object { $_.permission -eq 'SendOnBehalf' }).Count
        total        = $granted.Count
        inherited    = @($permissions | Where-Object { $_.inherited }).Count
        orphaned     = @($permissions | Where-Object { $_.orphaned }).Count
    }
    permissions = $permissions
}
Write-AdminForgeLog "${address}: $($result.summary.fullAccess) Full Access, $($result.summary.sendAs) Send As, $($result.summary.sendOnBehalf) Send on Behalf"
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
