<#
.SYNOPSIS
    Forwarding audit: mailboxes that forward mail, flagging forwarding to external domains.

.DESCRIPTION
    Finds mailbox-level forwarding (ForwardingSmtpAddress / ForwardingAddress) and, optionally, inbox rules
    that forward or redirect mail. A target is "external" when its domain is not one of the tenant's
    accepted domains.

.PARAMETER Inputs
    includeInboxRules      bool  Also inspect inbox rules (one Get-InboxRule call per mailbox; default false).
    maxMailboxesForRules   int   Inspect inbox rules of at most this many mailboxes, 1-5000 (default 500).
    externalOnly           bool  Return only findings with an external target (default false).

.PARAMETER Context
    Supplied by the runner: JobId, Mode, Tenant, Services, User.

.OUTPUTS
    @{ acceptedDomains; summary = @{ mailboxForwarding; inboxRuleForwarding; external; mailboxesScannedForRules };
       findings = @(@{ mailbox; userPrincipalName; source = 'mailbox'|'inboxRule'; ruleName; ruleEnabled; target;
                       external; deliverToMailboxAndForward }) }

.NOTES
    Tokens: exchange. Mode: read. Exchange role: View-Only Recipients + View-Only Configuration
    (Get-InboxRule needs Mail Recipients or higher).
#>
[CmdletBinding()]
param(
    [hashtable]$Inputs = @{},
    [hashtable]$Context = @{}
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$includeInboxRules = Get-AdminForgeInput $Inputs 'includeInboxRules' -Type Bool -Default $false
$maxMailboxesForRules = Get-AdminForgeInput $Inputs 'maxMailboxesForRules' -Type Int -Default 500 -Minimum 1 -Maximum 5000
$externalOnly = Get-AdminForgeInput $Inputs 'externalOnly' -Type Bool -Default $false

Write-AdminForgeProgress -Percent 5 -Message 'Reading accepted domains'
$acceptedDomains = @(Get-AcceptedDomain | ForEach-Object { ([string]$_.DomainName).ToLowerInvariant() })

function Get-TargetInfo([string]$Text) {
    # Accepts "smtp:user@contoso.com", "User Name [SMTP:user@contoso.com]" or a bare address.
    $match = [regex]::Match($Text, '[A-Za-z0-9._%+\-'']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')
    if (-not $match.Success) { return @{ address = $Text; external = $null } }
    $address = $match.Value.ToLowerInvariant()
    $domain = $address.Split('@')[1]
    $internal = $false
    foreach ($accepted in $acceptedDomains) {
        if ($domain -eq $accepted -or $domain.EndsWith(".$accepted")) { $internal = $true; break }
    }
    @{ address = $address; external = -not $internal }
}

$findings = [System.Collections.Generic.List[object]]::new()

Write-AdminForgeProgress -Percent 15 -Message 'Reading mailbox forwarding'
$forwarding = @(Get-EXOMailbox -ResultSize Unlimited -Filter '(ForwardingSmtpAddress -ne $null) -or (ForwardingAddress -ne $null)' `
        -Properties ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward |
        Select-Object DisplayName, UserPrincipalName, PrimarySmtpAddress, ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward)

foreach ($mbx in $forwarding) {
    if ($mbx.ForwardingSmtpAddress) {
        $info = Get-TargetInfo ([string]$mbx.ForwardingSmtpAddress)
        $findings.Add([ordered]@{
                mailbox = [string]$mbx.PrimarySmtpAddress; userPrincipalName = [string]$mbx.UserPrincipalName; source = 'mailbox'
                ruleName = $null; ruleEnabled = $null; target = $info.address; external = $info.external
                deliverToMailboxAndForward = [bool]$mbx.DeliverToMailboxAndForward
            })
    }
    if ($mbx.ForwardingAddress) {
        # ForwardingAddress points at a recipient object (often a mail contact); resolve its address.
        $target = [string]$mbx.ForwardingAddress
        try {
            $recipient = Get-EXORecipient -Identity $target -Properties ExternalEmailAddress | Select-Object PrimarySmtpAddress, ExternalEmailAddress
            $target = if ($recipient.ExternalEmailAddress) { [string]$recipient.ExternalEmailAddress } else { [string]$recipient.PrimarySmtpAddress }
        } catch {
            Write-AdminForgeLog -Level Warn "Could not resolve forwarding target of $($mbx.PrimarySmtpAddress)"
        }
        $info = Get-TargetInfo $target
        $findings.Add([ordered]@{
                mailbox = [string]$mbx.PrimarySmtpAddress; userPrincipalName = [string]$mbx.UserPrincipalName; source = 'mailbox'
                ruleName = $null; ruleEnabled = $null; target = $info.address; external = $info.external
                deliverToMailboxAndForward = [bool]$mbx.DeliverToMailboxAndForward
            })
    }
}
$mailboxForwarding = $findings.Count
Write-AdminForgeLog "$mailboxForwarding mailbox-level forwarding settings found"

$scanned = 0
if ($includeInboxRules) {
    Write-AdminForgeProgress -Percent 30 -Message 'Reading mailboxes for inbox rules'
    $mailboxes = @(Get-EXOMailbox -ResultSize $maxMailboxesForRules -RecipientTypeDetails UserMailbox, SharedMailbox |
            Select-Object PrimarySmtpAddress, UserPrincipalName)
    foreach ($mbx in $mailboxes) {
        $scanned++
        if ($scanned % 20 -eq 0) { Write-AdminForgeProgress -Percent (30 + [Math]::Floor(65 * $scanned / $mailboxes.Count)) -Message "Inbox rules: $scanned of $($mailboxes.Count)" }
        try {
            $rules = @(Get-InboxRule -Mailbox ([string]$mbx.PrimarySmtpAddress) | Select-Object Name, Enabled, ForwardTo, ForwardAsAttachmentTo, RedirectTo)
        } catch {
            Write-AdminForgeLog -Level Warn "Could not read inbox rules of $($mbx.PrimarySmtpAddress): $($_.Exception.Message)"
            continue
        }
        foreach ($rule in $rules) {
            $targets = @($rule.ForwardTo) + @($rule.ForwardAsAttachmentTo) + @($rule.RedirectTo) | Where-Object { $_ }
            foreach ($t in $targets) {
                $info = Get-TargetInfo ([string]$t)
                $findings.Add([ordered]@{
                        mailbox = [string]$mbx.PrimarySmtpAddress; userPrincipalName = [string]$mbx.UserPrincipalName; source = 'inboxRule'
                        ruleName = [string]$rule.Name; ruleEnabled = [bool]$rule.Enabled; target = $info.address; external = $info.external
                        deliverToMailboxAndForward = $null
                    })
            }
        }
    }
    if ($mailboxes.Count -ge $maxMailboxesForRules) { Write-AdminForgeLog -Level Warn "Inbox rules were inspected for the first $maxMailboxesForRules mailboxes only" }
}

$all = $findings.ToArray()
$result = [ordered]@{
    acceptedDomains = $acceptedDomains
    summary         = [ordered]@{
        mailboxForwarding        = $mailboxForwarding
        inboxRuleForwarding      = $all.Count - $mailboxForwarding
        external                 = @($all | Where-Object { $_.external -eq $true }).Count
        mailboxesScannedForRules = $scanned
    }
    findings        = if ($externalOnly) { @($all | Where-Object { $_.external -eq $true }) } else { $all }
}
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
