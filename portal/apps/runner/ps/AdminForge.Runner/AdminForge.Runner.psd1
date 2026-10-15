@{
    RootModule           = 'AdminForge.Runner.psm1'
    ModuleVersion        = '0.1.0'
    GUID                 = '6f1d4f0e-2b8a-4c55-9a3e-0d6c7b1e2a41'
    Author               = 'AdminForge'
    Description          = 'Helpers for AdminForge runner scripts: event output, input validation, delegated-token connections and read-only enforcement.'
    PowerShellVersion    = '7.4'
    CompatiblePSEditions = @('Core')
    FunctionsToExport    = @(
        'Set-AdminForgeEventSink', 'Send-AdminForgeEvent', 'Send-AdminForgeStreamRecord',
        'Write-AdminForgeLog', 'Write-AdminForgeProgress', 'Write-AdminForgeOutput',
        'New-AdminForgeError', 'Get-AdminForgeErrorCategory', 'Get-AdminForgeInput',
        'Connect-AdminForgeServices', 'Enable-AdminForgeReadOnlyMode', 'Get-AdminForgeMode',
        'Test-AdminForgeReadOnlyScript', 'Assert-AdminForgeReadOnlyScript'
    )
    CmdletsToExport      = @()
    VariablesToExport    = @()
    AliasesToExport      = @()
    PrivateData          = @{ PSData = @{ Tags = @('AdminForge') } }
}
