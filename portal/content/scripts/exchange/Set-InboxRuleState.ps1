<#
.SYNOPSIS
    Disables, enables or removes one inbox rule of a mailbox.

.DESCRIPTION
    Finds the rule by its RuleIdentity among the mailbox's rules (Get-InboxRule; hidden rules are refused because the
    cmdlets can't change them), checks it still has
    the expected name (a list can be out of date), and changes only what differs: Disable-InboxRule /
    Enable-InboxRule for a rule in the other state, Remove-InboxRule for removal (idempotent: a rule that is already
    gone is reported as unchanged). Reads the rule back and returns before/after, plus the rule's own description so
    the run record keeps what a removed rule did. The cmdlets run with -Force: Exchange otherwise asks to confirm
    that rules turned off in Outlook may be lost, which nobody can answer in an unattended run.
    Turning on a rule that forwards, forwards as attachment or redirects to an address outside the accepted domains is
    refused (the same test as Get-InboxRules.ps1's "high" risk): that is how mail leaves the organization unseen.
    The Entra object id of the mailbox's account is an input too, so AdminForge's protected-object guard sees whose
    mailbox this is before the write runs; it must equal the mailbox's ExternalDirectoryObjectId.

.PARAMETER Inputs
    mailbox          string  Required. Primary SMTP address or UPN of the mailbox.
    mailboxObjectId  string  Required. Entra object id of the mailbox's account (its ExternalDirectoryObjectId).
    ruleIdentity     string  Required. The rule's RuleIdentity (digits, from Get-InboxRules.ps1).
    action           string  Required. disable | enable | remove.
    ruleName         string  The name the rule had when it was listed; refused when it no longer matches.

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ mailbox; ruleIdentity; ruleName; action; before = @{ exists; enabled }; after = @{ exists; enabled };
       rule = @{ name; enabled; priority; description; forwardTo; redirectTo; externalTargets; deleteMessage; moveToFolder };
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
    throw (New-AdminForgeError -Category readOnly -Message 'Changing an inbox rule changes data; run this script in write mode (armed session).')
}
$mailboxInput = Get-AdminForgeInput $Inputs 'mailbox' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320
$mailboxObjectId = Get-AdminForgeInput $Inputs 'mailboxObjectId' -Required -Pattern '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
$ruleIdentity = Get-AdminForgeInput $Inputs 'ruleIdentity' -Required -Pattern '^\d{1,20}$'
$action = (Get-AdminForgeInput $Inputs 'action' -Required -AllowedValues 'disable', 'enable', 'remove').ToLowerInvariant()
$ruleName = Get-AdminForgeInput $Inputs 'ruleName' -MaxLength 512

function Find-Rule([switch]$Hidden) {
    $params = @{ Mailbox = $mailbox }
    if ($Hidden) { $params.IncludeHidden = $true }
    @(Get-InboxRule @params |
            Select-Object Name, RuleIdentity, Enabled, Priority, Description, ForwardTo, ForwardAsAttachmentTo, RedirectTo,
            DeleteMessage, SoftDeleteMessage, MoveToFolder |
            Where-Object { [string]$_.RuleIdentity -eq $ruleIdentity }) | Select-Object -First 1
}
function Get-Text($Values) { @(@($Values) | Where-Object { $_ } | ForEach-Object { [string]$_ }) }
# Same reading as Get-InboxRules.ps1: "Name [EX:/o=…]" is a recipient of the organization; otherwise the address's
# domain must be one of the accepted domains.
function Test-External([string]$Text, [string[]]$Accepted) {
    if ($Text -match '^\s*"?[^"\[]*?"?\s*\[EX:') { return $false }
    $match = [regex]::Match($Text, '[A-Za-z0-9._%+\-'']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
    if (-not $match.Success) { return $false }
    $domain = $match.Value.ToLowerInvariant().Split('@')[1]
    @($Accepted | Where-Object { $domain -eq $_ -or $domain.EndsWith(".$_") }).Count -eq 0
}

Write-AdminForgeProgress -Percent 5 -Message 'Reading mailbox'
try {
    $mbx = Get-EXOMailbox -Identity $mailboxInput | Select-Object PrimarySmtpAddress, ExternalDirectoryObjectId
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$mailboxInput' was not found: $($_.Exception.Message)")
}
$mailbox = [string]$mbx.PrimarySmtpAddress
if ([string]$mbx.ExternalDirectoryObjectId -ine $mailboxObjectId) {
    throw (New-AdminForgeError -Category input -Message "The account given for $mailbox doesn't match the mailbox, so nothing was changed. Refresh the inbox rule audit and start over.")
}

Write-AdminForgeProgress -Percent 10 -Message 'Reading inbox rules'
try {
    $rule = Find-Rule
    # Hidden rules (Exchange's own, such as the junk e-mail rule, or ones an app or attacker hid) can't be changed with
    # the inbox-rule cmdlets: they answer "couldn't be found".
    if (-not $rule -and (Find-Rule -Hidden)) {
        throw (New-AdminForgeError -Category input -Message "The rule with id $ruleIdentity in $mailbox is hidden (created by Exchange or an app, not shown in Outlook), so it can't be changed here. If it is suspicious, remove it with a MAPI editor or ask Microsoft support.")
    }
} catch {
    if ((Get-AdminForgeErrorCategory $_) -eq 'input') { throw }
    throw (New-AdminForgeError -Category input -Message "Could not read the inbox rules of ${mailbox}: $($_.Exception.Message)")
}

$result = [ordered]@{
    mailbox      = $mailbox
    ruleIdentity = $ruleIdentity
    ruleName     = if ($rule) { [string]$rule.Name } else { $ruleName }
    action       = $action
    before       = [ordered]@{ exists = [bool]$rule; enabled = if ($rule) { [bool]$rule.Enabled } else { $null } }
    after        = $null
    rule         = $null
    changed      = $false
    verified     = $false
}

if (-not $rule) {
    if ($action -eq 'remove') {
        Write-AdminForgeLog "The rule is no longer in $mailbox; nothing to remove"
        $result.after = $result.before
        $result.verified = $true
        Write-AdminForgeOutput -Data $result
        return
    }
    throw (New-AdminForgeError -Category input -Message "$mailbox has no inbox rule with id $ruleIdentity any more. Refresh the list and try again.")
}
if ($ruleName -and [string]$rule.Name -cne $ruleName) {
    throw (New-AdminForgeError -Category input -Message "The rule with id $ruleIdentity in $mailbox is now called '$($rule.Name)', not '$ruleName'. Refresh the list and try again.")
}
$targets = @(Get-Text $rule.ForwardTo) + @(Get-Text $rule.ForwardAsAttachmentTo) + @(Get-Text $rule.RedirectTo)
$external = @()
if ($targets.Count) {
    $accepted = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() })
    $external = @($targets | Where-Object { Test-External $_ $accepted })
}
$result.rule = [ordered]@{
    name            = [string]$rule.Name
    enabled         = [bool]$rule.Enabled
    priority        = $rule.Priority
    description     = if ($rule.Description) { ([string]$rule.Description).Trim() } else { $null }
    forwardTo       = @(Get-Text $rule.ForwardTo) + @(Get-Text $rule.ForwardAsAttachmentTo)
    redirectTo      = @(Get-Text $rule.RedirectTo)
    externalTargets = $external
    deleteMessage   = [bool]$rule.DeleteMessage -or [bool]$rule.SoftDeleteMessage
    moveToFolder    = if ($rule.MoveToFolder) { [string]$rule.MoveToFolder } else { $null }
}

$wantEnabled = $action -eq 'enable'
if ($action -eq 'enable' -and -not [bool]$rule.Enabled -and $external.Count) {
    throw (New-AdminForgeError -Category input -Message "The rule '$($rule.Name)' in $mailbox sends mail outside the organization ($($external -join ', ')), so AdminForge doesn't turn it on. If the person really needs it, they can turn it on in Outlook after the forwarding has been reviewed; nothing was changed.")
}
if ($action -ne 'remove' -and [bool]$rule.Enabled -eq $wantEnabled) {
    Write-AdminForgeLog "The rule '$($rule.Name)' is already $(if ($wantEnabled) { 'enabled' } else { 'disabled' }); nothing to do"
    $result.after = $result.before
    $result.verified = $true
    Write-AdminForgeProgress -Percent 100 -Message 'Nothing to change'
    Write-AdminForgeOutput -Data $result
    return
}

Write-AdminForgeProgress -Percent 40 -Message "$action rule"
$verb = @{ disable = 'Disabling'; enable = 'Enabling'; remove = 'Removing' }[$action]
Write-AdminForgeLog "$verb inbox rule '$($rule.Name)' in $mailbox"
$params = @{ Mailbox = $mailbox; Identity = $ruleIdentity; Confirm = $false; Force = $true }
switch ($action) {
    'disable' { Disable-InboxRule @params }
    'enable' { Enable-InboxRule @params }
    'remove' { Remove-InboxRule @params }
}
$result.changed = $true

for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-AdminForgeProgress -Percent (50 + 15 * $attempt) -Message "Verifying ($attempt)"
    $now = Find-Rule
    $result.after = [ordered]@{ exists = [bool]$now; enabled = if ($now) { [bool]$now.Enabled } else { $null } }
    $done = if ($action -eq 'remove') { -not $now } else { $now -and [bool]$now.Enabled -eq $wantEnabled }
    if ($done) { $result.verified = $true; break }
    Start-Sleep -Seconds 3
}
if (-not $result.verified) { Write-AdminForgeLog -Level Warn "The change was submitted but the rule in $mailbox doesn't show it yet" }

Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
