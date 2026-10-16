<#
.SYNOPSIS
    Inbox-rule audit: rules that forward or redirect mail outside the organization, delete it, or hide it in
    rarely checked folders — for one mailbox or the first N mailboxes of the organization.

.DESCRIPTION
    Reads inbox rules with Get-InboxRule (one call per mailbox) and classifies each rule:
      high    forwards, forwards as attachment or redirects to an address outside the accepted domains
      medium  deletes messages, or moves them to Deleted Items, Junk Email, RSS Feeds/Subscriptions or
              Conversation History (common ways to hide mail from the owner after a compromise)
      low     forwards or redirects inside the organization
    With riskyOnly (default) only high and medium rules are returned; the summary counts every rule read.
    ruleIdentity (Exchange's RuleIdentity) identifies a rule for Set-InboxRuleState.ps1; names need not be unique.
    With includeHidden, rules missing from the normal listing are flagged hidden (they can't be changed with the
    inbox-rule cmdlets). A target is "external" when its domain is not
    one of the tenant's accepted domains.

.PARAMETER Inputs
    identity        string  Primary SMTP address or UPN of one mailbox. Empty = scan the organization.
    maxMailboxes    int     Organization scan: inspect at most this many user and shared mailboxes, 1-5000 (default 500).
    riskyOnly       bool    Return only high and medium rules (default true).
    includeHidden   bool    Include hidden rules (Get-InboxRule -IncludeHidden; default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ scope = 'mailbox'|'organization'; acceptedDomains;
       summary = @{ mailboxesScanned; mailboxesFailed; rules; high; medium; low; externalForwarding; deleting; hiding };
       rules = @(@{ key; mailbox; userPrincipalName; ruleName; ruleIdentity; hidden; enabled; priority; risk; reasons; targets;
                    externalTargets; deletes; moveToFolder; markAsRead; stopProcessingRules; conditions }) }

.NOTES
    Tokens: exchange. Mode: read. Exchange role: Mail Recipients (Get-InboxRule) or View-Only Recipients for the list.
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identity = Get-AdminForgeInput $Inputs 'identity' -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320
$maxMailboxes = Get-AdminForgeInput $Inputs 'maxMailboxes' -Type Int -Default 500 -Minimum 1 -Maximum 5000
$riskyOnly = Get-AdminForgeInput $Inputs 'riskyOnly' -Type Bool -Default $true
$includeHidden = Get-AdminForgeInput $Inputs 'includeHidden' -Type Bool -Default $false

Write-AdminForgeProgress -Percent 5 -Message 'Reading accepted domains'
$acceptedDomains = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() })

function Get-TargetInfo([string]$Text) {
    # Accepts "smtp:user@contoso.com", "User Name [SMTP:user@contoso.com]" or a bare address. Recipients of the
    # organization appear as "User Name [EX:/o=ExchangeLabs/…]" (no address): internal, shown by name.
    $ex = [regex]::Match($Text, '^\s*"?(?<name>[^"\[]*?)"?\s*\[EX:')
    if ($ex.Success) { return @{ address = $(if ($ex.Groups['name'].Value) { $ex.Groups['name'].Value } else { 'Recipient in the organization' }); external = $false } }
    $match = [regex]::Match($Text, '[A-Za-z0-9._%+\-'']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
    if (-not $match.Success) { return @{ address = $Text; external = $false } }
    $address = $match.Value.ToLowerInvariant()
    $domain = $address.Split('@')[1]
    $internal = @($acceptedDomains | Where-Object { $domain -eq $_ -or $domain.EndsWith(".$_") }).Count -gt 0
    @{ address = $address; external = -not $internal }
}
$hidingFolders = '(?i)(^|\\|:)(Deleted Items|Junk E-?mail|RSS Feeds|RSS Subscriptions|Conversation History)$'
function Join-Short($Values, [int]$Max = 5) {
    $list = @(@($Values) | Where-Object { $_ } | ForEach-Object { [string]$_ })
    if (-not $list.Count) { return $null }
    $text = ($list | Select-Object -First $Max) -join ', '
    if ($list.Count -gt $Max) { $text += " (+$($list.Count - $Max))" }
    $text
}

if ($identity) {
    Write-AdminForgeProgress -Percent 10 -Message 'Reading mailbox'
    try {
        $mailboxes = @(Get-EXOMailbox -Identity $identity | Select-Object PrimarySmtpAddress, UserPrincipalName)
    } catch {
        throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
    }
} else {
    Write-AdminForgeProgress -Percent 10 -Message 'Reading mailboxes'
    $mailboxes = @(Get-EXOMailbox -ResultSize $maxMailboxes -RecipientTypeDetails UserMailbox, SharedMailbox | Select-Object PrimarySmtpAddress, UserPrincipalName)
}

$rules = [System.Collections.Generic.List[object]]::new()
$byRisk = @{ high = 0; medium = 0; low = 0; none = 0 }
$scanned = 0
$failed = 0
$total = 0
foreach ($mbx in $mailboxes) {
    $scanned++
    if ($mailboxes.Count -gt 1 -and $scanned % 20 -eq 0) {
        Write-AdminForgeProgress -Percent (10 + [Math]::Floor(85 * $scanned / $mailboxes.Count)) -Message "Inbox rules: $scanned of $($mailboxes.Count)"
    }
    $address = [string]$mbx.PrimarySmtpAddress
    $params = @{ Mailbox = $address }
    if ($includeHidden) { $params.IncludeHidden = $true }
    try {
        $raw = @(Get-InboxRule @params | Select-Object Name, RuleIdentity, Enabled, Priority, ForwardTo, ForwardAsAttachmentTo, RedirectTo, DeleteMessage,
            SoftDeleteMessage, MoveToFolder, MarkAsRead, StopProcessingRules, From, SubjectContainsWords, SubjectOrBodyContainsWords, BodyContainsWords)
        # Hidden rules (Exchange's own, or ones an app or attacker hid) are those missing from the normal listing.
        $visibleIds = if ($includeHidden) { @(Get-InboxRule -Mailbox $address | Select-Object RuleIdentity | ForEach-Object { [string]$_.RuleIdentity }) } else { @() }
    } catch {
        $failed++
        Write-AdminForgeLog -Level Warn "Could not read inbox rules of ${address}: $($_.Exception.Message)"
        if ($identity) { throw }
        continue
    }
    foreach ($rule in $raw) {
        $total++
        $forward = @(@($rule.ForwardTo) + @($rule.ForwardAsAttachmentTo) | Where-Object { $_ } | ForEach-Object { Get-TargetInfo ([string]$_) })
        $redirect = @(@($rule.RedirectTo) | Where-Object { $_ } | ForEach-Object { Get-TargetInfo ([string]$_) })
        $targets = @($forward + $redirect)
        $external = @($targets | Where-Object { $_.external } | ForEach-Object { $_.address } | Select-Object -Unique)
        $deletes = [bool]$rule.DeleteMessage -or [bool]$rule.SoftDeleteMessage
        $moveTo = if ($rule.MoveToFolder) { [string]$rule.MoveToFolder } else { $null }
        $hides = [bool]($moveTo -and $moveTo -match $hidingFolders)

        $reasons = [System.Collections.Generic.List[string]]::new()
        if (@($forward | Where-Object { $_.external }).Count) { $reasons.Add('Forwards outside the organization') }
        if (@($redirect | Where-Object { $_.external }).Count) { $reasons.Add('Redirects outside the organization') }
        if ($deletes) { $reasons.Add('Deletes messages') }
        if ($hides) { $reasons.Add("Moves messages to $(($moveTo -split '[\\:]')[-1])") }
        if ($targets.Count -and -not $external.Count) { $reasons.Add('Forwards inside the organization') }
        if ([bool]$rule.MarkAsRead -and ($deletes -or $hides)) { $reasons.Add('Marks messages as read') }
        $risk = if ($external.Count) { 'high' } elseif ($deletes -or $hides) { 'medium' } elseif ($targets.Count) { 'low' } else { 'none' }
        $byRisk[$risk]++
        if ($riskyOnly -and $risk -notin 'high', 'medium') { continue }

        $conditions = @(
            $(if ($rule.From) { "From: $(Join-Short $rule.From)" })
            $(if ($rule.SubjectContainsWords) { "Subject contains: $(Join-Short $rule.SubjectContainsWords)" })
            $(if ($rule.SubjectOrBodyContainsWords) { "Subject or body contains: $(Join-Short $rule.SubjectOrBodyContainsWords)" })
            $(if ($rule.BodyContainsWords) { "Body contains: $(Join-Short $rule.BodyContainsWords)" })
        ) | Where-Object { $_ }
        $rules.Add([ordered]@{
                key                 = "$address|$(if ($rule.RuleIdentity) { $rule.RuleIdentity } else { "$($rule.Name)|$($rule.Priority)" })".ToLowerInvariant()
                mailbox             = $address
                userPrincipalName   = [string]$mbx.UserPrincipalName
                ruleName            = [string]$rule.Name
                ruleIdentity        = if ($rule.RuleIdentity) { [string]$rule.RuleIdentity } else { $null }
                hidden              = [bool]($includeHidden -and $rule.RuleIdentity -and $visibleIds -notcontains [string]$rule.RuleIdentity)
                enabled             = [bool]$rule.Enabled
                priority            = $rule.Priority
                risk                = $risk
                reasons             = $reasons.ToArray()
                targets             = @($targets | ForEach-Object { $_.address } | Select-Object -Unique)
                externalTargets     = $external
                deletes             = $deletes
                moveToFolder        = $moveTo
                markAsRead          = [bool]$rule.MarkAsRead
                stopProcessingRules = [bool]$rule.StopProcessingRules
                conditions          = if ($conditions) { $conditions -join '; ' } else { $null }
            })
    }
}
if (-not $identity -and $mailboxes.Count -ge $maxMailboxes) { Write-AdminForgeLog -Level Warn "Inbox rules were inspected for the first $maxMailboxes mailboxes only" }

$all = $rules.ToArray()
$result = [ordered]@{
    scope           = if ($identity) { 'mailbox' } else { 'organization' }
    acceptedDomains = $acceptedDomains
    summary         = [ordered]@{
        mailboxesScanned   = $scanned - $failed
        mailboxesFailed    = $failed
        rules              = $total
        # Counted over every rule read, also when riskyOnly leaves the low ones out of the list.
        high               = $byRisk['high']
        medium             = $byRisk['medium']
        low                = $byRisk['low']
        externalForwarding = @($all | Where-Object { $_.externalTargets.Count }).Count
        deleting           = @($all | Where-Object { $_.deletes }).Count
        hiding             = @($all | Where-Object { $_.moveToFolder -and $_.moveToFolder -match $hidingFolders }).Count
    }
    rules           = $all
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
