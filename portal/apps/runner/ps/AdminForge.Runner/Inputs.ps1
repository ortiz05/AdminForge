<#
    AdminForge.Runner — inputs. Dot-sourced by AdminForge.Runner.psm1 into the module's scope (which sets strict mode);
    not loaded on its own.

    Get-AdminForgeInput is how a script reads $Inputs: typed (String, Int, Bool, StringArray, Object), bounded (length,
    range, count) and checked (pattern, allowed values). A missing or invalid value throws an 'input' error
    (New-AdminForgeError, Errors.ps1). Inputs are data and never become script text.
#>

#region Inputs

function Get-AdminForgeInput {
    <#
    .SYNOPSIS
        Reads and validates one value from $Inputs. Throws an 'input' error when it is missing or invalid.
    .DESCRIPTION
        Inputs are data: they are validated and typed here and must never be pasted into script text or
        Invoke-Expression.
    .EXAMPLE
        $identity = Get-AdminForgeInput $Inputs 'identity' -Required -Pattern '^[^\s@]+@[^\s@]+$'
    .EXAMPLE
        $max = Get-AdminForgeInput $Inputs 'resultSize' -Type Int -Default 1000 -Minimum 1 -Maximum 50000
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][AllowNull()][System.Collections.IDictionary]$Inputs,
        [Parameter(Mandatory, Position = 1)][string]$Name,
        [ValidateSet('String', 'Int', 'Bool', 'StringArray', 'Object')][string]$Type = 'String',
        [switch]$Required,
        $Default,
        [string]$Pattern,
        [string[]]$AllowedValues,
        [long]$Minimum = [long]::MinValue,
        [long]$Maximum = [long]::MaxValue,
        [int]$MaxCount = 10000,
        [int]$MaxLength = 4096
    )
    $present = $null -ne $Inputs -and $Inputs.Contains($Name) -and $null -ne $Inputs[$Name] -and -not ($Inputs[$Name] -is [string] -and $Inputs[$Name] -eq '')
    if (-not $present) {
        if ($Required) { throw (New-AdminForgeError -Category input -Message "Input '$Name' is required." -ErrorId 'AdminForge.InputMissing') }
        if ($PSBoundParameters.ContainsKey('Default')) { return $Default }
        if ($Type -eq 'StringArray') { return , [string[]]@() }
        return $null
    }
    $value = $Inputs[$Name]
    $fail = { param($why) throw (New-AdminForgeError -Category input -Message "Input '$Name' $why" -ErrorId 'AdminForge.InputInvalid') }
    $checkString = {
        param([string]$s)
        if ($s.Length -gt $MaxLength) { & $fail "is longer than $MaxLength characters." }
        if ($Pattern -and $s -notmatch $Pattern) { & $fail 'has an invalid format.' }
        if ($AllowedValues -and $s -notin $AllowedValues) { & $fail "must be one of: $($AllowedValues -join ', ')." }
    }
    switch ($Type) {
        'String' {
            if ($value -isnot [string]) { & $fail 'must be a string.' }
            & $checkString $value
            return [string]$value
        }
        'Int' {
            if ($value -isnot [int] -and $value -isnot [long]) { & $fail 'must be a whole number.' }
            if ($value -lt $Minimum -or $value -gt $Maximum) {
                $range = if ($PSBoundParameters.ContainsKey('Minimum') -and $PSBoundParameters.ContainsKey('Maximum')) { "between $Minimum and $Maximum" }
                elseif ($PSBoundParameters.ContainsKey('Maximum')) { "at most $Maximum" } else { "at least $Minimum" }
                & $fail "must be $range."
            }
            return [long]$value
        }
        'Bool' {
            if ($value -isnot [bool]) { & $fail 'must be true or false.' }
            return [bool]$value
        }
        'StringArray' {
            if ($value -isnot [string] -and $value -isnot [System.Collections.IList]) { & $fail 'must be a list of strings.' }
            $items = @($value)
            if ($items.Count -gt $MaxCount) { & $fail "has more than $MaxCount entries." }
            foreach ($item in $items) {
                if ($item -isnot [string]) { & $fail 'must contain only strings.' }
                & $checkString $item
            }
            return , [string[]]$items
        }
        'Object' { return $value }
    }
}

#endregion
