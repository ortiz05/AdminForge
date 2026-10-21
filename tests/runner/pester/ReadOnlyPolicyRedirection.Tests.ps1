#Requires -Version 7.4
# The read-only policy refuses file redirection (S-35): `>`, `>>`, `2>`, `*>` and the other numbered streams write a
# file without calling a command, so the command allow-list never saw them. A read-mode script that passed review
# could fill the runner's writable paths (emptyDirs with a sizeLimit: past it the kubelet evicts the whole pod, API
# included). Merging a stream into the output (`2>&1`, `*>&1`) writes no file and stays allowed. Run with
# tests/runner/pester/run.ps1.

BeforeDiscovery {
    $refused = @(
        @{ Code = 'Get-Date > out.txt'; Text = '> out.txt' }
        @{ Code = 'Get-Date >> out.txt'; Text = '>> out.txt' }
        @{ Code = 'Get-Date 2> err.txt'; Text = '2> err.txt' }
        @{ Code = 'Get-Date *> all.txt'; Text = '*> all.txt' }
        @{ Code = 'Get-Date 1> out.txt'; Text = '1> out.txt' }
        @{ Code = 'Get-Date 3>> warnings.txt'; Text = '3>> warnings.txt' }
        @{ Code = 'Get-Date 6> info.txt'; Text = '6> info.txt' }
        @{ Code = "Get-Date > '/tmp/out.txt'"; Text = "> '/tmp/out.txt'" }
        @{ Code = '$path = "/home/adminforge/x"; Get-Date > $path'; Text = '> $path' }
        @{ Code = 'Get-Date > $null'; Text = '> $null' }
        @{ Code = 'Get-Date 2>&1 > out.txt'; Text = '> out.txt' }
        @{ Code = 'Get-Date *>&1 >> out.txt'; Text = '>> out.txt' }
        @{ Code = '@(1, 2) > out.txt'; Text = '> out.txt' }
        @{ Code = '1..3 | ForEach-Object { $_ > "row-$_.txt" }'; Text = '> "row-$_.txt"' }
        @{ Code = 'function Get-Thing { Get-Date >> log.txt }; Get-Thing'; Text = '>> log.txt' }
        @{ Code = '$x = $(Get-Date > out.txt)'; Text = '> out.txt' }
    )

    $allowed = @(
        @{ Code = 'Get-Date 2>&1' }
        @{ Code = 'Get-Date *>&1 | Out-String' }
        @{ Code = 'Get-Date 3>&1 4>&1 5>&1 6>&1' }
        @{ Code = 'Get-Date | Out-Null' }
        @{ Code = "if (2 -gt 1) { 'a > b' }" }
        @{ Code = "Write-AdminForgeLog 'rows > 0'" }
    )
}

BeforeAll {
    $script:RunnerRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/apps/runner')).Path
    Import-Module (Join-Path $RunnerRoot 'ps/AdminForge.Runner/AdminForge.Runner.psd1') -Force

    function Invoke-Worker([hashtable]$Job) {
        $env:ADMINFORGE_RUNNER_PRELOAD = 'none'
        try {
            $lines = (ConvertTo-Json -InputObject $Job -Depth 10 -Compress) | & pwsh -NoLogo -NoProfile -NonInteractive -File (Join-Path $RunnerRoot 'ps/worker.ps1') 2>$null
        } finally {
            Remove-Item Env:ADMINFORGE_RUNNER_PRELOAD -ErrorAction SilentlyContinue
        }
        @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json -AsHashtable })
    }
    function New-Job([string]$Mode, [string]$Content) {
        @{
            jobId = 'pester-redirection'; mode = $Mode; inputs = @{}; tokens = @{}; timeoutSeconds = 60
            script = @{ path = 'pester/Redirection.ps1'; sha256 = ('0' * 64); content = $Content }
            tenant = @{ id = '0f3a4c2e-8b1d-4e6f-9a7c-2d5b8e1f4a63'; domain = 'example.onmicrosoft.com' }
        }
    }
}

Describe 'Static read-only policy: file redirection' {
    It 'refuses <Code>' -ForEach $refused {
        $findings = @(Test-AdminForgeReadOnlyScript -Content $Code)
        $finding = $findings | Where-Object Text -EQ $Text | Select-Object -First 1
        $finding | Should -Not -BeNullOrEmpty -Because "a finding for '$Text' (got: $($findings.Text -join ' | '))"
        $finding.Message | Should -BeLike "'$([WildcardPattern]::Escape($Text))' is not allowed in read-only mode. Read-only scripts can't redirect output to a file* (line $($finding.Line))"
    }

    It 'allows <Code>' -ForEach $allowed {
        (@(Test-AdminForgeReadOnlyScript -Content $Code) | ForEach-Object Message) | Should -BeNullOrEmpty
    }

    It 'names the redirection, its line and column' {
        $finding = @(Test-AdminForgeReadOnlyScript -Content "Get-Date`nGet-Date 2> err.txt") | Select-Object -First 1
        $finding.Line | Should -Be 2
        $finding.Column | Should -Be 10
        $finding.Message | Should -Be "'2> err.txt' is not allowed in read-only mode. Read-only scripts can't redirect output to a file (to discard it, pipe to Out-Null or use -ErrorAction SilentlyContinue). (line 2)"
    }
}

Describe 'worker.ps1 refuses file redirection in read mode before the script runs' {
    It 'refuses the job and writes no file' {
        $target = Join-Path $TestDrive 'read-mode.txt'
        $events = Invoke-Worker (New-Job 'read' "Write-AdminForgeOutput -Data 'ran'`nGet-Date > '$target'")
        $err = @($events | Where-Object type -EQ 'error')
        $err.Count | Should -Be 1
        $err[0].category | Should -Be 'readOnly'
        $err[0].message | Should -BeLike "*can't redirect output to a file*(line 2)"
        $events | Where-Object type -EQ 'output' | Should -BeNullOrEmpty
        $events[-1].status | Should -Be 'failed'
        Test-Path -LiteralPath $target | Should -BeFalse
    }

    It 'leaves write mode alone (armed scripts may write files)' {
        $target = Join-Path $TestDrive 'write-mode.txt'
        $events = Invoke-Worker (New-Job 'write' "Get-Date > '$target'`nWrite-AdminForgeOutput -Data 'ran'")
        ($events | Where-Object type -EQ 'output').data | Should -Be 'ran'
        Test-Path -LiteralPath $target | Should -BeTrue
    }
}
