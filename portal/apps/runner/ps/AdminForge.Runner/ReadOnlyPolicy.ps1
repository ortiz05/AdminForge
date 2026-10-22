<#
    AdminForge.Runner — read-only policy. Dot-sourced by AdminForge.Runner.psm1 into the module's scope (which sets
    strict mode); not loaded on its own.

    SECURITY BOUNDARY. Read-mode jobs run with tokens that can write; this file is what keeps a read-mode script to
    reads: the static policy (Test-AdminForgeReadOnlyScript / Assert-AdminForgeReadOnlyScript), the runtime guards
    (Enable-AdminForgeReadOnlyMode) and the mode scripts can ask for (Get-AdminForgeMode). The rules are described in
    the region comment below. Any change needs tests in tests/runner/pester/ReadOnlyPolicy*.Tests.ps1 and a security
    review (.claude/agents/security-reviewer.md).
#>

# 'read' after Enable-AdminForgeReadOnlyMode, otherwise 'write' (Get-AdminForgeMode).
$script:Mode = 'write'

#region Read-only mode

<#
    Read-mode jobs run with the engineer's Read-app tokens, and some of those can write (Exchange.Manage, SharePoint
    AllSites.FullControl). Two layers keep a read-mode script to reads:

    1. Before the script runs (Test-AdminForgeReadOnlyScript): a static policy over the parsed script. Allowed are
       Get-* commands, the AdminForge script helpers, a fixed set of PowerShell utilities and the script's own
       functions. Refused before anything connects: module-qualified names of any other command
       (ExchangeOnlineManagement\Set-Mailbox), PowerShell's own commands outside the allow-list (Invoke-RestMethod,
       Invoke-Expression, Add-Type, New-Object, Import-Module, Start-ThreadJob, Get-Content …), dynamic invocation
       (& $x, . $x), scripts and programs by path, Get-* commands that hand out tokens or live connections, .NET types
       outside a small allow-list, reflection and invocation members (.Invoke(), .GetType(), .ExecuteQuery() …), the
       engine variables ($ExecutionContext, $Host, $PSCmdlet), provider variables (${function:…}, $env:…), classes,
       using statements and file redirection (> out.txt, >>, 2>, *>, also > $null; merging a stream into the
       output, 2>&1, writes no file and stays allowed). A SharePoint client object a Get-PnP* cmdlet returns queues
       a change when a property is set or a method like Update() is called, and the connection's next request sends
       it, so: properties and indexes may be set (=, +=, ++) only on a variable the script assigns nothing but
       @{…} or [ordered]@{…} (never an automatic variable, a parameter, a foreach or -PipelineVariable variable);
       set_*() accessors, .ForEach('Name', value) and wildcard member names in ForEach-Object are refused; and
       common change methods (Update, Delete…, Recycle, Set…, CopyTo, Publish, Approve, Move…, Share…) are
       refused by name. That list is a deny-list, not a complete one (docs/backlog.md, constrained runspace).
    2. While it runs (Enable-AdminForgeReadOnlyMode): every non-Get command of every loaded service module
       (Exchange Online, its tmpEXO_* module, Teams, PnP, Microsoft Graph, Az …) is replaced by a constant guard,
       Invoke-MgGraphRequest / Invoke-AzRestMethod accept only GET, unknown non-Get commands fail as read-only, and
       module auto-loading is off. Unqualified service write commands (Set-Mailbox) are refused here, at the call.

    Write-mode jobs run without either layer. This is not a full sandbox: the script runs in FullLanguage (the
    existing read scripts need .NET collections and [Math], which ConstrainedLanguage refuses), so the static
    policy is the boundary. See docs/backlog.md (constrained runspace).
#>

# Script API of this module; everything else it exports is for the worker.
$script:ScriptHelpers = @(
    'Write-AdminForgeLog', 'Write-AdminForgeProgress', 'Write-AdminForgeOutput', 'Get-AdminForgeInput',
    'New-AdminForgeError', 'Get-AdminForgeMode'
)
$script:InternalCommands = @(
    'Set-AdminForgeEventSink', 'Send-AdminForgeEvent', 'Send-AdminForgeStreamRecord', 'Get-AdminForgeErrorCategory',
    'Format-AdminForgeMessage', 'Connect-AdminForgeServices', 'Enable-AdminForgeReadOnlyMode',
    'Test-AdminForgeReadOnlyScript', 'Assert-AdminForgeReadOnlyScript',
    # worker.ps1 defines these in the scope the job script runs in.
    'Send-WorkerLine', 'Send-WorkerError', 'Exit-Worker'
)
# PowerShell's own commands a read-mode script may call; every other command PowerShell ships is refused.
$script:ReadOnlyCoreCommands = @(
    'ForEach-Object', 'Where-Object', 'Select-Object', 'Sort-Object', 'Group-Object', 'Measure-Object', 'Compare-Object',
    'Get-Unique', 'Get-Member', 'Start-Sleep', 'Get-Date', 'New-TimeSpan', 'Get-Random', 'Join-String',
    'ConvertTo-Json', 'ConvertFrom-Json', 'ConvertTo-Csv', 'ConvertFrom-Csv', 'Out-String', 'Out-Null',
    'Write-Output', 'Write-Verbose', 'Write-Debug', 'Write-Warning', 'Write-Information', 'Write-Error', 'Write-Host',
    'Set-StrictMode', 'Get-ChildItem'
)
$script:ReadOnlyAliases = @{
    '%' = 'ForEach-Object'; 'foreach' = 'ForEach-Object'; '?' = 'Where-Object'; 'where' = 'Where-Object'
    'select' = 'Select-Object'; 'sort' = 'Sort-Object'; 'group' = 'Group-Object'; 'measure' = 'Measure-Object'
    'sleep' = 'Start-Sleep'; 'echo' = 'Write-Output'
}
# Get-* commands that hand out tokens, credentials or live client objects (which can write).
$script:ReadOnlyDeniedGetPattern = '(?i)token|credential|secret|password'
$script:ReadOnlyDeniedGetCommands = @('Get-PnPConnection', 'Get-PnPContext', 'Get-ConnectionInformation', 'Get-AzContext')
# .NET types a read-mode script may name (lower case, without "system."); generic arguments are checked too.
$script:ReadOnlyTypes = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
        'string', 'char', 'bool', 'boolean', 'byte', 'sbyte', 'int', 'int16', 'int32', 'int64', 'uint16', 'uint32',
        'uint64', 'long', 'short', 'ushort', 'uint', 'ulong', 'double', 'single', 'float', 'decimal', 'bigint',
        'numerics.biginteger', 'datetime', 'datetimeoffset', 'timespan', 'guid', 'regex', 'text.regularexpressions.regex',
        'text.regularexpressions.regexoptions', 'text.regularexpressions.match', 'math', 'ordered', 'hashtable',
        'collections.hashtable', 'array', 'object', 'psobject', 'pscustomobject', 'management.automation.psobject',
        'management.automation.pscustomobject', 'collections.generic.list', 'collections.generic.hashset',
        'collections.generic.dictionary', 'collections.generic.sortedset', 'collections.generic.sorteddictionary',
        'collections.generic.queue', 'collections.generic.stack', 'collections.arraylist', 'collections.idictionary',
        'collections.ilist', 'collections.icollection', 'collections.ienumerable',
        'collections.specialized.ordereddictionary', 'stringcomparison', 'stringcomparer', 'midpointrounding',
        'text.stringbuilder', 'globalization.cultureinfo', 'cultureinfo', 'globalization.datetimestyles',
        'net.webutility', 'convert', 'uri', 'version', 'void', 'switch',
        'management.automation.switchparameter', 'mailaddress', 'net.mail.mailaddress', 'ipaddress', 'net.ipaddress',
        'management.automation.errorrecord', 'exception', 'invalidoperationexception', 'argumentexception'
    ), [System.StringComparer]::OrdinalIgnoreCase)
# Members that run code, reflect, reach the engine, or commit/send through client objects.
$script:ReadOnlyDeniedMethodPattern = '(?i)^(invoke\w*|begininvoke|endinvoke|dynamicinvoke|gettype|get(method|constructor|field|property|member|event|nestedtype|interface)s?|createinstance\w*|createdelegate|makegeneric(type|method)|new(bound)?scriptblock|getnewclosure|getpowershell|getsteppablepipeline|getcommand\w*|getcmdlet\w*|executequery\w*|add(command|script|statement|parameters?|argument)|start|kill|send\w*|upload\w*|download\w*|getresponse\w*|getrequeststream\w*|\w+async)$'
# Methods that change the object they are called on (SharePoint client objects queue the change and the connection's next
# request sends it): a deny-list of common names, not a complete one (docs/backlog.md, constrained runspace).
$script:ReadOnlyChangeMethodPattern = '(?i)^(\w*update\w*|\w*delete\w*|\w*recycle\w*|\w*restore\w*|\w*roleinheritance|ensureuser|adduser|removeby\w*|set(?!equals$)\w+|check(in|out)|undocheckout|\w*publish|approve|deny|move(?!next$)\w*|copyto\w*|\w*upload\w*|apply\w*|\w*shar(e|ing)\w*)$'
$script:ReadOnlyDeniedMembers = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
        'SessionState', 'InvokeCommand', 'InvokeProvider', 'PSVariable', 'Runspace', 'RunspacePool', 'Context', 'Host'
    ), [System.StringComparer]::OrdinalIgnoreCase)
$script:ReadOnlyDeniedVariables = @('ExecutionContext', 'Host', 'PSCmdlet', 'PSModuleAutoLoadingPreference')

# Every command PowerShell itself ships (core cmdlets, built-in aliases/functions, the modules under $PSHOME).
# Computed once at import: later, module auto-loading may be off.
$script:PowerShellCommands = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($entry in [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2().Commands) { [void]$script:PowerShellCommands.Add($entry.Name) }
$script:PowerShellModuleNames = @(Get-ChildItem -LiteralPath (Join-Path $PSHOME 'Modules') -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
if ($script:PowerShellModuleNames.Count) {
    foreach ($command in @(Get-Command -Module $script:PowerShellModuleNames -ErrorAction SilentlyContinue)) { [void]$script:PowerShellCommands.Add($command.Name) }
}

function Test-AdminForgePowerShellModule {
    # True for PowerShell's own modules (under $PSHOME) and the core snap-in.
    param([AllowNull()][System.Management.Automation.PSModuleInfo]$Module)
    if (-not $Module) { return $false }
    if ($Module.Name -eq 'Microsoft.PowerShell.Core') { return $true }
    $base = [string]$Module.ModuleBase
    [bool]($base -and $base.StartsWith($PSHOME, [System.StringComparison]::OrdinalIgnoreCase))
}

function Test-AdminForgeReadOnlyType {
    param([System.Management.Automation.Language.ITypeName]$TypeName)
    if ($TypeName -is [System.Management.Automation.Language.ArrayTypeName]) { return Test-AdminForgeReadOnlyType $TypeName.ElementType }
    if ($TypeName -is [System.Management.Automation.Language.GenericTypeName]) {
        if (-not (Test-AdminForgeReadOnlyType $TypeName.TypeName)) { return $false }
        foreach ($argument in $TypeName.GenericArguments) { if (-not (Test-AdminForgeReadOnlyType $argument)) { return $false } }
        return $true
    }
    $name = ([string]$TypeName.Name).Trim()
    if ($name.StartsWith('System.', [System.StringComparison]::OrdinalIgnoreCase)) { $name = $name.Substring(7) }
    $script:ReadOnlyTypes.Contains($name)
}

function Get-AdminForgeReadOnlyCommandProblem {
    # $null when the command may appear in a read-mode script (it may still be refused at the call by the guard);
    # otherwise why not.
    param([string]$Name, [System.Collections.Generic.HashSet[string]]$Defined)
    $why = 'Read-only scripts can call Get-* commands of the connected services and a fixed set of helpers; changes need a write-mode playbook step (armed session).'
    if ($Name -match '[/:~]' -or $Name.StartsWith('.') -or $Name.StartsWith('\') -or ($Name -split '\\').Count -gt 2 -or $Name -match '(?i)\.(ps1|psm1|psd1|exe|dll|sh|cmd|bat)$') {
        return "Read-only scripts can't run other scripts or programs."
    }
    $qualified = $Name.Contains('\')
    $bare = ($Name -split '\\')[-1]
    if (-not $qualified -and $Defined.Contains($bare)) { return $null }
    if (-not $qualified -and $script:ReadOnlyAliases.ContainsKey($bare)) { return $null }
    if ($bare -in $script:ScriptHelpers -or $bare -in $script:ReadOnlyCoreCommands) { return $null }
    if ($bare -in $script:InternalCommands) { return $why }
    if ($bare -match '^Get-[A-Za-z0-9]+$') {
        if ($bare -match $script:ReadOnlyDeniedGetPattern -or $bare -in $script:ReadOnlyDeniedGetCommands) {
            return "Read-only scripts can't read tokens, credentials or live connections."
        }
        if ($script:PowerShellCommands.Contains($bare)) { return $why }
        return $null
    }
    # Service write commands by plain name are left to the guards (refused at the call, see Enable-AdminForgeReadOnlyMode).
    if ($qualified -or $bare -notmatch '^[A-Za-z]+-[A-Za-z0-9]+$' -or $script:PowerShellCommands.Contains($bare)) { return $why }
    $null
}

function Test-AdminForgeReadOnlyScript {
    <#
    .SYNOPSIS
        Checks a script against the read-only policy before it runs. Returns one finding per violation, in script
        order (@{ Line; Column; Text; Message }), or nothing when the script may run in read mode.
    .DESCRIPTION
        See the region comment above for what is allowed. Scripts that do not parse return nothing (running them
        reports the parse error). Message reads "'<construct>' is not allowed in read-only mode. <why> (line N)".
    .EXAMPLE
        Test-AdminForgeReadOnlyScript -Content (Get-Content -Raw ./Get-Thing.ps1)
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Content)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Content, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { return }

    $defined = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        [void]$defined.Add(($f.Name -split ':', 2)[-1])
    }
    # Variables every assignment of which is a hashtable literal (@{…} or [ordered]@{…}): the only objects a read-mode
    # script may set properties on. A property set on an object a service returned (a SharePoint client object) is a
    # change the connection's next request sends.
    $hashtables = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $notHashtables = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $variableName = { param($Variable) ($Variable.VariablePath.UserPath -split ':')[-1] }
    foreach ($n in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
        $right = $n.Right
        if ($right -is [System.Management.Automation.Language.PipelineAst] -and $right.PipelineElements.Count -eq 1) { $right = $right.PipelineElements[0] }
        if ($right -is [System.Management.Automation.Language.CommandExpressionAst]) { $right = $right.Expression }
        if ($right -is [System.Management.Automation.Language.ConvertExpressionAst] -and $right.Type.TypeName.Name -eq 'ordered') { $right = $right.Child }
        $literal = $n.Operator -eq 'Equals' -and $right -is [System.Management.Automation.Language.HashtableAst]
        if ($n.Left -is [System.Management.Automation.Language.VariableExpressionAst]) {
            [void]$(if ($literal) { $hashtables.Add((& $variableName $n.Left)) } else { $notHashtables.Add((& $variableName $n.Left)) })
        } else {
            foreach ($v in $n.Left.FindAll({ param($x) $x -is [System.Management.Automation.Language.VariableExpressionAst] }, $false)) {
                if ($n.Left -isnot [System.Management.Automation.Language.MemberExpressionAst] -and $n.Left -isnot [System.Management.Automation.Language.IndexExpressionAst]) { [void]$notHashtables.Add((& $variableName $v)) }
            }
        }
    }
    foreach ($auto in '_', 'PSItem', 'args', 'input', 'this', 'Matches', 'foreach', 'switch') { [void]$notHashtables.Add($auto) }
    foreach ($n in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ForEachStatementAst] }, $true)) { [void]$notHashtables.Add((& $variableName $n.Variable)) }
    foreach ($n in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ParameterAst] }, $true)) { [void]$notHashtables.Add((& $variableName $n.Name)) }
    foreach ($n in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
        $elements = @($n.CommandElements)
        for ($i = 0; $i -lt $elements.Count; $i++) {
            $e = $elements[$i]
            if ($e -isnot [System.Management.Automation.Language.CommandParameterAst]) { continue }
            $pn = $e.ParameterName
            $isVar = $pn -match '^(?i)(ov|pv|ev|wv|iv)$' -or ($pn.Length -ge 2 -and @('OutVariable', 'PipelineVariable', 'ErrorVariable', 'WarningVariable', 'InformationVariable' | Where-Object { $_.StartsWith($pn, [System.StringComparison]::OrdinalIgnoreCase) }).Count)
            if (-not $isVar) { continue }
            $value = if ($e.Argument) { $e.Argument } elseif ($i + 1 -lt $elements.Count) { $elements[$i + 1] }
            if ($value -is [System.Management.Automation.Language.StringConstantExpressionAst]) { [void]$notHashtables.Add((($value.Value -replace '^\+', '') -split ':')[-1]) }
            else { [void]$notHashtables.Add('*') }
        }
    }
    foreach ($n in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.HashtableAst] }, $true)) {
        foreach ($pair in $n.KeyValuePairs) {
            $key = if ($pair.Item1 -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $pair.Item1.Value } else { '' }
            if ($key -match '^(?i)(ov|pv)$' -or ($key.Length -ge 2 -and @('OutVariable', 'PipelineVariable' | Where-Object { $_.StartsWith($key, [System.StringComparison]::OrdinalIgnoreCase) }).Count)) { [void]$notHashtables.Add('*') }
        }
    }
    $settable = {
        param($Target)
        while ($true) {
            if ($Target -is [System.Management.Automation.Language.AttributedExpressionAst]) { $Target = $Target.Child; continue }
            if ($Target -is [System.Management.Automation.Language.ParenExpressionAst]) { $pure = $Target.Pipeline.GetPureExpression(); if (-not $pure) { return $false }; $Target = $pure; continue }
            break
        }
        if ($Target -is [System.Management.Automation.Language.ArrayLiteralAst]) { foreach ($el in $Target.Elements) { if (-not (& $settable $el)) { return $false } }; return $true }
        if ($Target -is [System.Management.Automation.Language.VariableExpressionAst]) { return $true }
        if ($Target -is [System.Management.Automation.Language.IndexExpressionAst]) {
            $recv = $Target.Target
            if ($recv -isnot [System.Management.Automation.Language.VariableExpressionAst]) { return $false }
            $rn = & $variableName $recv
            return ($hashtables.Contains($rn) -and -not $notHashtables.Contains($rn) -and -not $notHashtables.Contains('*'))
        }
        if ($Target -isnot [System.Management.Automation.Language.MemberExpressionAst] -or $Target -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) { return $false }
        if ($Target.Static -or $Target.Expression -isnot [System.Management.Automation.Language.VariableExpressionAst]) { return $false }
        $name = & $variableName $Target.Expression
        $hashtables.Contains($name) -and -not $notHashtables.Contains($name) -and -not $notHashtables.Contains('*')
    }
    $setWhy = "Read-only scripts can set properties and indexes only on a variable the script assigns nothing but @{…} or [ordered]@{…} (a new one per row, under its own name); changing an object a service returned needs a write-mode playbook step (armed session)."

    $findings = [System.Collections.Generic.List[object]]::new()
    $flag = {
        param($Node, [string]$Text, [string]$Why)
        $line = $Node.Extent.StartLineNumber
        if ($Text.Length -gt 80) { $Text = $Text.Substring(0, 77) + '...' }
        $findings.Add([pscustomobject]@{
                Line    = $line
                Column  = $Node.Extent.StartColumnNumber
                Text    = $Text
                Message = "'$Text' is not allowed in read-only mode. $Why (line $line)"
            })
    }
    $codeWhy = "Read-only scripts can't run code, use reflection or send requests through .NET objects."
    $changeWhy = "Read-only scripts can't call methods that change an object (Update, Delete…, Recycle, Set…, CopyTo …): changes need a write-mode playbook step (armed session). To copy a collection, use @(`$collection)."
    $checkMember = {
        param($Node, $Member, [bool]$Invoked)
        if ($Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
            if ($Invoked) { & $flag $Node $Node.Extent.Text 'Methods must be called by name in read-only mode.' }
            return
        }
        $name = $Member.Value
        if ($script:ReadOnlyDeniedMembers.Contains($name) -or ($Invoked -and $name -match $script:ReadOnlyDeniedMethodPattern)) {
            & $flag $Node ".$name" $codeWhy
        } elseif ($Invoked -and $name -match $script:ReadOnlyChangeMethodPattern) {
            & $flag $Node ".$name" $changeWhy
        }
    }

    $reqs = $ast.ScriptRequirements
    if ($reqs -and (($reqs.RequiredModules -and $reqs.RequiredModules.Count) -or ($reqs.RequiredAssemblies -and $reqs.RequiredAssemblies.Count))) {
        & $flag $ast '#Requires' "Read-only scripts can't load modules or assemblies."
    }

    foreach ($node in $ast.FindAll({ $true }, $true)) {
        switch ($node.GetType().Name) {
            'CommandAst' {
                $first = $node.CommandElements[0]
                if ($first -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { break }
                if ($first -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Commands must be called by name in read-only mode.'
                    break
                }
                $name = $first.Value
                $problem = Get-AdminForgeReadOnlyCommandProblem -Name $name -Defined $defined
                if ($problem) { & $flag $node $name $problem; break }
                $bare = ($name -split '\\')[-1]
                $canonical = if ($script:ReadOnlyAliases.ContainsKey($bare) -and -not $defined.Contains($bare)) { $script:ReadOnlyAliases[$bare] } else { $bare }
                if ($defined.Contains($bare)) { break }
                $elements = @($node.CommandElements | Select-Object -Skip 1)
                if ($canonical -eq 'ForEach-Object') {
                    # Positional 0 / -MemberName names a property or method; -Parallel and -AsJob run in other runspaces.
                    $checkMemberElement = {
                        param($Element)
                        if ($Element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $Element.Value -match '[*?\[]') { & $flag $node $node.Extent.Text 'Members must be named exactly (no wildcards) in read-only mode.' }
                        elseif ($Element -is [System.Management.Automation.Language.StringConstantExpressionAst]) { & $checkMember $node $Element $true }
                        elseif ($Element -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
                            & $flag $node $node.Extent.Text 'Methods must be called by name in read-only mode.'
                        }
                    }
                    $switches = 'AsJob', 'UseNewRunspace', 'WhatIf', 'Confirm', 'Verbose', 'Debug'
                    $positional = 0
                    $i = 0
                    while ($i -lt $elements.Count) {
                        $element = $elements[$i]
                        if ($element -isnot [System.Management.Automation.Language.CommandParameterAst]) {
                            if ($positional -eq 0) { & $checkMemberElement $element }
                            $positional++
                            $i++
                            continue
                        }
                        $p = $element.ParameterName
                        $startsWith = { param($Full) $p.Length -ge 2 -and $Full.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase) }
                        if ((& $startsWith 'Parallel') -or (& $startsWith 'AsJob') -or (& $startsWith 'UseNewRunspace')) {
                            & $flag $element "ForEach-Object -$p" 'Parallel and background execution is not allowed in read-only mode.'
                        }
                        $isMember = $p.Length -ge 1 -and 'MemberName'.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)
                        $isSwitch = @($switches | Where-Object { $p.Length -ge 1 -and $_.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
                        if ($element.Argument) {
                            if ($isMember) { & $checkMemberElement $element.Argument }
                            $i++
                        } elseif ($isSwitch) {
                            $i++
                        } else {
                            if ($isMember -and $i + 1 -lt $elements.Count) { & $checkMemberElement $elements[$i + 1] }
                            $i += 2
                        }
                    }
                } elseif ($canonical -eq 'Get-ChildItem') {
                    $paths = 0
                    $bad = $false
                    $expectPath = $false
                    foreach ($element in $elements) {
                        if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
                            if ($element.ParameterName -notin 'Path', 'LiteralPath', 'Name') { $bad = $true; break }
                            if ($element.ParameterName -eq 'Name') { continue }
                            if ($element.Argument) {
                                if ($element.Argument -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $element.Argument.Value -match '^(?i)env:[\\/]?$') { $paths++ } else { $bad = $true; break }
                            } else { $expectPath = $true }
                            continue
                        }
                        $expectPath = $false
                        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $element.Value -match '^(?i)env:[\\/]?$') { $paths++ } else { $bad = $true; break }
                    }
                    if ($bad -or $expectPath -or $paths -eq 0) {
                        & $flag $node $node.Extent.Text 'Get-ChildItem can list only env: in read-only mode.'
                    }
                }
            }
            'InvokeMemberExpressionAst' {
                if ($node.Static -and $node.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Static members can be used only on a type name in read-only mode.'
                    break
                }
                & $checkMember $node $node.Member $true
                if ($node.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Member.Value -in 'ForEach', 'Where' -and @($node.Arguments).Count) {
                    $argument = @($node.Arguments)[0]
                    if ($argument -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Member.Value -eq 'ForEach' -and @($node.Arguments).Count -ge 2) { & $flag $node $node.Extent.Text $setWhy }
                    elseif ($argument -is [System.Management.Automation.Language.StringConstantExpressionAst]) { & $checkMember $node $argument $true }
                    elseif ($argument -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst] -and $argument -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                        & $flag $node $node.Extent.Text 'Methods must be called by name in read-only mode.'
                    }
                }
            }
            'MemberExpressionAst' {
                if ($node.Static -and $node.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Static members can be used only on a type name in read-only mode.'
                    break
                }
                & $checkMember $node $node.Member $false
            }
            'AssignmentStatementAst' {
                if (-not (& $settable $node.Left)) { & $flag $node $node.Left.Extent.Text $setWhy }
            }
            'UnaryExpressionAst' {
                if ($node.TokenKind -in 'PlusPlus', 'MinusMinus', 'PostfixPlusPlus', 'PostfixMinusMinus' -and -not (& $settable $node.Child)) { & $flag $node $node.Child.Extent.Text $setWhy }
            }
            'TypeExpressionAst' {
                if (-not (Test-AdminForgeReadOnlyType $node.TypeName)) { & $flag $node "[$($node.TypeName.FullName)]" 'Read-only scripts can use only basic .NET types (text, numbers, dates, collections, regex, Math).' }
            }
            'TypeConstraintAst' {
                if (-not (Test-AdminForgeReadOnlyType $node.TypeName)) { & $flag $node "[$($node.TypeName.FullName)]" 'Read-only scripts can use only basic .NET types (text, numbers, dates, collections, regex, Math).' }
            }
            'BinaryExpressionAst' {
                if ($node.Operator -eq 'As' -and $node.Right -isnot [System.Management.Automation.Language.TypeExpressionAst]) {
                    & $flag $node $node.Extent.Text 'Conversions need a type name ([type]) in read-only mode.'
                }
            }
            'VariableExpressionAst' {
                $path = $node.VariablePath
                if ($path.IsDriveQualified) { & $flag $node $node.Extent.Text "Read-only scripts can't use provider variables (env:, function:, variable: …)."; break }
                $bareName = ($path.UserPath -split ':')[-1]
                if ($bareName -in $script:ReadOnlyDeniedVariables) { & $flag $node "`$$bareName" "Read-only scripts can't use the PowerShell engine, the host or module loading." }
            }
            # > out.txt, >>, 2>, *>, n>: writes a file without calling a command (Out-File and Set-Content are refused
            # as commands). A MergingRedirectionAst (2>&1, *>&1) only merges a stream into the output: allowed.
            'FileRedirectionAst' { & $flag $node $node.Extent.Text "Read-only scripts can't redirect output to a file (to discard output, pipe it to Out-Null; to silence a stream, use -ErrorAction or -WarningAction SilentlyContinue)." }
            'UsingStatementAst' { & $flag $node $node.Extent.Text 'Using statements are not allowed in read-only mode.' }
            'TypeDefinitionAst' { & $flag $node "class $($node.Name)" 'Classes and enums are not allowed in read-only mode.' }
            'ConfigurationDefinitionAst' { & $flag $node 'configuration' 'Configurations are not allowed in read-only mode.' }
            'DynamicKeywordStatementAst' { & $flag $node $node.Extent.Text 'Dynamic keywords are not allowed in read-only mode.' }
        }
    }
    $findings | Sort-Object -Property Line, Column
}

function Assert-AdminForgeReadOnlyScript {
    <#
    .SYNOPSIS
        Throws a 'readOnly' error for the first violation of the read-only policy (Test-AdminForgeReadOnlyScript).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Content)
    $finding = @(Test-AdminForgeReadOnlyScript -Content $Content) | Select-Object -First 1
    if ($finding) { throw (New-AdminForgeError -Category readOnly -Message $finding.Message -ErrorId 'AdminForge.ReadOnlyPolicy') }
}

function New-AdminForgeReadOnlyBlock {
    param([string]$CommandName)
    $blocked = $CommandName
    {
        $ex = [System.InvalidOperationException]::new("'$blocked' is not allowed in read-only mode. Only Get-* commands are available; run a write-mode job (armed session) to make changes.")
        $ex.Data['AdminForge.Category'] = 'readOnly'
        throw [System.Management.Automation.ErrorRecord]::new($ex, 'AdminForge.ReadOnlyMode', [System.Management.Automation.ErrorCategory]::PermissionDenied, $blocked)
    }.GetNewClosure()
}

function New-AdminForgeGetOnlyProxy {
    # Proxy for a REST cmdlet (Invoke-MgGraphRequest, Invoke-AzRestMethod) that allows only -Method GET.
    param([System.Management.Automation.CommandInfo]$Command)
    $metadata = [System.Management.Automation.CommandMetadata]::new($Command)
    $proxy = [System.Management.Automation.ProxyCommand]::Create($metadata)
    $guard = @'
    if ($PSBoundParameters.ContainsKey('Method') -and ([string]$PSBoundParameters['Method']).ToUpperInvariant() -ne 'GET') {
        $ex = [System.InvalidOperationException]::new("$($MyInvocation.MyCommand.Name) -Method $($PSBoundParameters['Method']) is not allowed in read-only mode. Only GET requests are available; run a write-mode job (armed session) to make changes.")
        $ex.Data['AdminForge.Category'] = 'readOnly'
        throw [System.Management.Automation.ErrorRecord]::new($ex, 'AdminForge.ReadOnlyMode', [System.Management.Automation.ErrorCategory]::PermissionDenied, $null)
    }
'@
    $regex = [regex]::new('begin\s*\{')
    if (-not $regex.IsMatch($proxy)) { throw "Could not build a read-only proxy for $($Command.Name)" }
    [scriptblock]::Create($regex.Replace($proxy, "begin`n{`n$guard", 1))
}

function Set-AdminForgeGlobalFunction {
    param([string]$Name, [scriptblock]$Body)
    $existing = Get-Item -LiteralPath "function:$Name" -ErrorAction SilentlyContinue
    if ($existing -and ($existing.Options -band [System.Management.Automation.ScopedItemOptions]::Constant)) { return $false } # already guarded
    # Imported module functions and aliases live in the global scope; from here, the provider finds and removes those.
    if (Test-Path -LiteralPath "alias:$Name") { Remove-Item -LiteralPath "alias:$Name" -Force }
    if ($existing) { Remove-Item -LiteralPath "function:$Name" -Force }
    # Constant: a script cannot remove or redefine the guard.
    New-Item -Path 'function:' -Name "global:$Name" -Value $Body -Options Constant -Force | Out-Null
    $true
}

function Enable-AdminForgeReadOnlyMode {
    <#
    .SYNOPSIS
        Restricts the session to read operations while a read-mode script runs (the second layer; the worker
        checks the script with Test-AdminForgeReadOnlyScript first).
    .DESCRIPTION
        - Invoke-MgGraphRequest and Invoke-AzRestMethod (and their aliases) accept only -Method GET.
        - Every other command of every loaded module that is not PowerShell's own or AdminForge.Runner (Exchange
          Online and its generated tmpEXO_* module, Teams, PnP, Microsoft Graph, Az, …) whose verb is not Get, and
          every alias to such a command, is replaced by a constant function that throws
          "'<name>' is not allowed in read-only mode". -ModuleName limits this to the named modules (tests).
        - Unknown Verb-Noun commands with a non-Get verb (e.g. Exchange cmdlets that were not loaded) fail with the
          same message instead of "not recognized".
        - Module auto-loading is turned off (after importing PowerShell's utility, management and security
          modules), so a call cannot load a module whose commands are not guarded.
        Module-qualified names (PnP.PowerShell\New-PnPList) bypass shadowing; the static policy refuses them
        before the script runs.
    #>
    [CmdletBinding()]
    param(
        [string[]]$ModuleName,
        [switch]$SkipRestGuards,
        [switch]$KeepModuleAutoLoading
    )
    $script:Mode = 'read'
    $blocked = 0

    if (-not $SkipRestGuards) {
        $rest = @(
            @{ Module = 'Microsoft.Graph.Authentication'; Name = 'Invoke-MgGraphRequest'; Aliases = @('Invoke-GraphRequest', 'Invoke-MgRestMethod') }
            @{ Module = 'Az.Accounts'; Name = 'Invoke-AzRestMethod'; Aliases = @('Invoke-AzRest') }
        )
        foreach ($entry in $rest) {
            if (-not (Get-Module -Name $entry.Module)) { continue }
            $command = Get-Command -Name "$($entry.Module)\$($entry.Name)" -CommandType Cmdlet -ErrorAction SilentlyContinue
            if (-not $command) { continue }
            $proxy = New-AdminForgeGetOnlyProxy -Command $command
            foreach ($name in @($entry.Name) + $entry.Aliases) { $null = Set-AdminForgeGlobalFunction -Name $name -Body $proxy }
        }
    }

    $commands = if ($ModuleName) {
        $modules = @(Get-Module -Name $ModuleName -ErrorAction SilentlyContinue)
        if ($modules.Count) { @(Get-Command -Module ($modules.Name | Select-Object -Unique) -ErrorAction SilentlyContinue) } else { @() }
    } else {
        @(Get-Command -ListImported -CommandType Alias, Function, Filter, Cmdlet -ErrorAction SilentlyContinue | Where-Object {
                $_.Module -and $_.Module.Name -ne 'AdminForge.Runner' -and -not (Test-AdminForgePowerShellModule $_.Module)
            })
    }
    foreach ($command in $commands) {
        $verb = ($command.Name -split '-', 2)[0]
        $target = if ($command.CommandType -eq 'Alias' -and $command.ResolvedCommandName) { ($command.ResolvedCommandName -split '-', 2)[0] } else { $verb }
        if ($verb -eq 'Get' -and $target -eq 'Get') { continue }
        if (Set-AdminForgeGlobalFunction -Name $command.Name -Body (New-AdminForgeReadOnlyBlock -CommandName $command.Name)) { $blocked++ }
    }

    $ExecutionContext.InvokeCommand.CommandNotFoundAction = {
        param([string]$CommandName, [System.Management.Automation.CommandLookupEventArgs]$EventArgs)
        $name = ($CommandName -split '\\')[-1]
        if ($name -match '^(?<verb>[A-Za-z]+)-[A-Za-z0-9]+$' -and $Matches['verb'] -ne 'Get') {
            $EventArgs.CommandScriptBlock = New-AdminForgeReadOnlyBlock -CommandName $name
            $EventArgs.StopSearch = $true
        }
    }

    if (-not $KeepModuleAutoLoading) {
        foreach ($name in 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security') {
            if (-not (Get-Module -Name $name)) { Import-Module -Name $name -Global -ErrorAction SilentlyContinue }
        }
        $global:PSModuleAutoLoadingPreference = 'None'
    }
    Write-Verbose "Read-only mode: blocked $blocked commands"
    $blocked
}

function Get-AdminForgeMode {
    <# .SYNOPSIS Returns 'read' after Enable-AdminForgeReadOnlyMode, otherwise 'write'. #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $script:Mode
}

#endregion
