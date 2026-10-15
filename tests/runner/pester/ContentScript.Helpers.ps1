# Shared by the content-script Pester files (dot-source it in BeforeAll). Not a test file itself: Pester only runs
# *.Tests.ps1. Runs portal/content/scripts exactly as the worker does (text → scriptblock, merged streams → events)
# against global stub cmdlets that return synthetic data (example.com / fabrikam.example), so no tenant is needed.

$script:Repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$script:ScriptsDir = Join-Path $script:Repo 'portal/content/scripts'
Import-Module (Join-Path $script:Repo 'portal/apps/runner/ps/AdminForge.Runner/AdminForge.Runner.psd1') -Force

function Invoke-ContentScript([string]$RelativePath, [hashtable]$Inputs = @{}, [string]$Mode = 'read', [hashtable]$Tenant) {
    $events = [System.Collections.Generic.List[object]]::new()
    Set-AdminForgeEventSink -ScriptBlock { param($e) $events.Add($e) }.GetNewClosure()
    if (-not $Tenant) { $Tenant = @{ Id = '0f3a4c2e-8b1d-4e6f-9a7c-2d5b8e1f4a63'; Domain = 'example.onmicrosoft.com'; SpoTenantName = 'example' } }
    $context = @{
        JobId = 'pester'; Mode = $Mode; Services = @('Exchange'); Tenant = $Tenant
        User = @{ Upn = 'engineer@example.com'; ObjectId = $null }
    }
    $sb = [scriptblock]::Create((Get-Content -Raw -LiteralPath (Join-Path $script:ScriptsDir $RelativePath)))
    $failure = $null
    try {
        & $sb -Inputs $Inputs -Context $context *>&1 | Send-AdminForgeStreamRecord
    } catch {
        $failure = $_
    } finally {
        Set-AdminForgeEventSink -Reset
    }
    [pscustomobject]@{
        Events   = $events.ToArray()
        Output   = @($events | Where-Object { $_.type -eq 'output' } | ForEach-Object { $_.data })
        Failure  = $failure
        Category = if ($failure) { Get-AdminForgeErrorCategory $failure } else { $null }
    }
}

function New-Stub([string]$Name, [scriptblock]$Body) { Set-Item -Path "function:global:$Name" -Value $Body }
function Remove-Stubs([string[]]$Names) {
    foreach ($name in $Names) { Remove-Item -Path "function:global:$name" -ErrorAction SilentlyContinue }
}
