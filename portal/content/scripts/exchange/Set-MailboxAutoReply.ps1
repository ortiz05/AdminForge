<#
.SYNOPSIS
    Turns a mailbox's automatic replies on (now or for a period) or off.

.DESCRIPTION
    Sets the automatic-reply configuration with Set-MailboxAutoReplyConfiguration and reads it back. Messages are
    plain text: they are HTML-encoded (line breaks become <br>) so nothing in them is interpreted as markup.
    Turning replies off keeps the stored messages.

.PARAMETER Inputs
    identity           string  Required. Primary SMTP address or UPN of the mailbox.
    state              string  Required. Enabled | Scheduled | Disabled.
    internalMessage    string  Reply to people in the organization (required unless Disabled; up to 4000 characters).
    externalMessage    string  Reply to outside senders (default: the internal message).
    externalAudience   string  None | Known | All (default All).
    startTime          string  Scheduled only: ISO 8601 start (e.g. 2026-10-20T09:00:00Z).
    endTime            string  Scheduled only: ISO 8601 end, after the start.

.PARAMETER Context
    Supplied by the runner: JobId, Mode (must be 'write'), Tenant, Services, User.

.OUTPUTS
    @{ identity; displayName; primarySmtpAddress; before = @{ state }; after = @{ state; externalAudience;
       startTime; endTime }; changed; verified }

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
    throw (New-AdminForgeError -Category readOnly -Message 'Changing automatic replies changes data; run this script in write mode (armed session).')
}
$iso = '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$'
$identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+\.[^\s@]+$' -MaxLength 320
$state = Get-AdminForgeInput $Inputs 'state' -Required -AllowedValues 'Enabled', 'Scheduled', 'Disabled'
$state = @('Enabled', 'Scheduled', 'Disabled') | Where-Object { $_ -eq $state }
$internalMessage = Get-AdminForgeInput $Inputs 'internalMessage' -MaxLength 4000
$externalMessage = Get-AdminForgeInput $Inputs 'externalMessage' -MaxLength 4000
$externalAudience = Get-AdminForgeInput $Inputs 'externalAudience' -AllowedValues 'None', 'Known', 'All' -Default 'All'
$externalAudience = @('None', 'Known', 'All') | Where-Object { $_ -eq $externalAudience }
$startText = Get-AdminForgeInput $Inputs 'startTime' -Pattern $iso -MaxLength 40
$endText = Get-AdminForgeInput $Inputs 'endTime' -Pattern $iso -MaxLength 40

if ($state -ne 'Disabled' -and [string]::IsNullOrWhiteSpace($internalMessage)) {
    throw (New-AdminForgeError -Category input -Message "Input 'internalMessage' is required to turn automatic replies on.")
}
$start = $null
$end = $null
if ($state -eq 'Scheduled') {
    if (-not $startText -or -not $endText) {
        throw (New-AdminForgeError -Category input -Message "Scheduled automatic replies need 'startTime' and 'endTime'.")
    }
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    $start = [datetime]::Parse($startText, [System.Globalization.CultureInfo]::InvariantCulture, $styles)
    $end = [datetime]::Parse($endText, [System.Globalization.CultureInfo]::InvariantCulture, $styles)
    if ($end -le $start) { throw (New-AdminForgeError -Category input -Message "'endTime' must be after 'startTime'.") }
}

# Plain text in, safe HTML out.
function ConvertTo-ReplyHtml([string]$Text) {
    ([System.Net.WebUtility]::HtmlEncode($Text.Trim())) -replace "`r?`n", '<br>'
}

Write-AdminForgeProgress -Percent 10 -Message 'Reading mailbox'
try {
    $mailbox = Get-EXOMailbox -Identity $identity | Select-Object DisplayName, PrimarySmtpAddress
} catch {
    throw (New-AdminForgeError -Category input -Message "Mailbox '$identity' was not found: $($_.Exception.Message)")
}
$address = [string]$mailbox.PrimarySmtpAddress
$read = {
    $a = Get-MailboxAutoReplyConfiguration -Identity $address | Select-Object AutoReplyState, ExternalAudience, StartTime, EndTime
    [ordered]@{
        state            = [string]$a.AutoReplyState
        externalAudience = [string]$a.ExternalAudience
        startTime        = if ($a.StartTime) { ([datetime]$a.StartTime).ToUniversalTime().ToString('o') } else { $null }
        endTime          = if ($a.EndTime) { ([datetime]$a.EndTime).ToUniversalTime().ToString('o') } else { $null }
    }
}
$before = & $read

$params = @{ Identity = $address; AutoReplyState = $state; Confirm = $false }
if ($state -ne 'Disabled') {
    $params.InternalMessage = ConvertTo-ReplyHtml $internalMessage
    $params.ExternalMessage = ConvertTo-ReplyHtml $(if ([string]::IsNullOrWhiteSpace($externalMessage)) { $internalMessage } else { $externalMessage })
    $params.ExternalAudience = $externalAudience
}
if ($state -eq 'Scheduled') {
    $params.StartTime = $start
    $params.EndTime = $end
}
Write-AdminForgeProgress -Percent 40 -Message "Setting automatic replies: $state"
Write-AdminForgeLog "Automatic replies of ${address}: $($before.state) -> $state"
Set-MailboxAutoReplyConfiguration @params

$after = & $read
$result = [ordered]@{
    identity           = $identity
    displayName        = [string]$mailbox.DisplayName
    primarySmtpAddress = $address
    before             = [ordered]@{ state = $before.state }
    after              = $after
    changed            = $true
    verified           = $after.state -eq $state
}
if (-not $result.verified) { Write-AdminForgeLog -Level Warn "Automatic replies of $address report $($after.state), expected $state" }
Write-AdminForgeProgress -Percent 100 -Message 'Done'
Write-AdminForgeOutput -Data $result
