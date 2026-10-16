<#
    AdminForge.Runner — errors. Dot-sourced by AdminForge.Runner.psm1 into the module's scope (which sets strict mode);
    not loaded on its own.

    Every failure a job reports carries an AdminForge category (input, auth, readOnly, script, timeout, cancelled,
    runner, protocol) so the portal can tell the engineer what to do. Scripts throw New-AdminForgeError; the worker maps
    any error record to its category with Get-AdminForgeErrorCategory. Format-AdminForgeMessage turns service error
    text (Exchange Online's embedded OData JSON, "|Exception.Type|" prefixes) into the sentence a person should read.
#>

$script:ErrorCategories = @('input', 'auth', 'readOnly', 'script', 'timeout', 'cancelled', 'runner', 'protocol')

#region Errors

function New-AdminForgeError {
    <#
    .SYNOPSIS
        Creates an ErrorRecord carrying an AdminForge error category. Throw it from a script.
    .EXAMPLE
        throw (New-AdminForgeError -Category input -Message 'identity is required')
    #>
    [CmdletBinding()]
    [OutputType([System.Management.Automation.ErrorRecord])]
    param(
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('input', 'auth', 'readOnly', 'script', 'runner')][string]$Category = 'script',
        [string]$ErrorId = 'AdminForge.ScriptError',
        [object]$TargetObject
    )
    $exception = [System.InvalidOperationException]::new($Message)
    $exception.Data['AdminForge.Category'] = $Category
    $psCategory = switch ($Category) {
        'input' { [System.Management.Automation.ErrorCategory]::InvalidArgument }
        'auth' { [System.Management.Automation.ErrorCategory]::AuthenticationError }
        'readOnly' { [System.Management.Automation.ErrorCategory]::PermissionDenied }
        default { [System.Management.Automation.ErrorCategory]::NotSpecified }
    }
    [System.Management.Automation.ErrorRecord]::new($exception, $ErrorId, $psCategory, $TargetObject)
}

function Get-AdminForgeErrorCategory {
    <# .SYNOPSIS Maps an ErrorRecord (or exception) to an AdminForge error category. #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowNull()]$ErrorRecord)
    $exception = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ErrorRecord.Exception } else { $ErrorRecord }
    while ($null -ne $exception) {
        if ($exception -is [System.Exception] -and $exception.Data.Contains('AdminForge.Category')) {
            $category = [string]$exception.Data['AdminForge.Category']
            if ($category -in $script:ErrorCategories) { return $category }
        }
        $exception = if ($exception -is [System.Exception]) { $exception.InnerException } else { $null }
    }
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord] -and $ErrorRecord.FullyQualifiedErrorId -like 'AdminForge.ReadOnlyMode*') { return 'readOnly' }
    'script'
}

function Format-AdminForgeMessage {
    <#
    .SYNOPSIS
        Makes a service error readable for the person in front of the browser: Exchange Online's REST errors embed the
        raw OData error JSON, and its remote cmdlets prefix "|Exception.Type|"; keep only the message text.
    .EXAMPLE
        Format-AdminForgeMessage $_.Exception.Message
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory, Position = 0)][AllowNull()][AllowEmptyString()][string]$Message)
    if ([string]::IsNullOrEmpty($Message)) { return $Message }
    $text = $Message
    # "An error occurred while processing this request.. {"error":{"code":"NotFound","message":"…",…}}. An error was read
    # from the payload. See the 'Error' property for more details.." → the OData error's message.
    $odata = [regex]::Match($text, '(?:An error occurred while processing this request\.*\s*)?\{"error":\{"code":"[^"]*","message":"(?<m>(?:[^"\\]|\\.)*)"[\s\S]*$')
    if ($odata.Success) {
        $inner = try { [string](ConvertFrom-Json -InputObject ('"' + $odata.Groups['m'].Value + '"')) } catch { $odata.Groups['m'].Value }
        $text = $text.Substring(0, $odata.Index) + $inner
    }
    # "|Microsoft.Exchange.….ManagementObjectNotFoundException|The operation …" or "||The operation …".
    $text = [regex]::Replace($text, '(^|\s)\|[A-Za-z0-9_.]*\|', '$1')
    $text = [regex]::Replace($text, '\.{2,}(\s|$)', '.$1')
    $text.Trim()
}

#endregion
