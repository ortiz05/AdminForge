#Requires -Version 7.4
# The read-only policy refuses changes to client objects (2026-10-22 security review): a SharePoint client object a
# Get-PnP* cmdlet returns queues a change when a property is set or Update(), DeleteObject(), Recycle() … is called,
# and the connection's next request sends it — under a Reader's token, in read mode. A read-mode script may set
# properties and indexes only on variables it assigns nothing but hashtable literals; set_*() accessors,
# .ForEach('Name', value) and wildcard member names are refused; and common change methods are refused by name (a
# deny-list: docs/backlog.md). Every shipped read script still passes (ReadOnlyPolicy.Tests.ps1). Run with
# tests/runner/pester/run.ps1.

BeforeDiscovery {
    $setRefused = @(
        @{ Code = '$w = Get-PnPWeb; $w.Title = "x"'; Text = '$w.Title' }
        @{ Code = 'Get-PnPWeb | ForEach-Object { $_.Title = "x" }'; Text = '$_.Title' }
        @{ Code = '$s = Get-PnPTenantSite -Identity $u; $s.SharingCapability = 0'; Text = '$s.SharingCapability' }
        @{ Code = '$w = Get-PnPWeb; $w.Title += "x"'; Text = '$w.Title' }
        @{ Code = '$w = Get-PnPWeb; [string]$w.Title = "x"'; Text = '[string]$w.Title' }
        @{ Code = '$h = @{ w = (Get-PnPWeb) }; $h.w.Title = "x"'; Text = '$h.w.Title' }
        @{ Code = '$h = @{}; $h = Get-PnPWeb; $h.Title = "x"'; Text = '$h.Title' }
        @{ Code = '$h = @{}; foreach ($h in Get-PnPList) { $h.Title = "x" }'; Text = '$h.Title' }
        @{ Code = 'param($h = @{}) $h.Title = "x"'; Text = '$h.Title' }
        @{ Code = '$h = @{}; Get-PnPWeb -OutVariable h | Out-Null; $h.Title = "x"'; Text = '$h.Title' }
        @{ Code = '$h = @{}; Get-PnPList -PipelineVariable h | ForEach-Object { $h.Title = "x" }'; Text = '$h.Title' }
        @{ Code = '$a, $h = @{}, (Get-PnPWeb); $h.Title = "x"'; Text = '$h.Title' }
        @{ Code = '$w = Get-PnPWeb; $w.Title.Length = 1'; Text = '$w.Title.Length' }
        @{ Code = '$l = Get-PnPList -Identity x; $l.ItemCount++'; Text = '$l.ItemCount' }
        @{ Code = '$l = Get-PnPList -Identity x; ++$l.ItemCount'; Text = '$l.ItemCount' }
        @{ Code = '$w = Get-PnPWeb; "$($w.Title = "x")"'; Text = '$w.Title' }
        @{ Code = '[Math]::PI = 3'; Text = '[Math]::PI' }
        @{ Code = '$w = Get-PnPWeb; $a, $w.Title = 1, 2'; Text = '$a, $w.Title' }
        @{ Code = '$w = Get-PnPWeb; ($w.Title) = "x"'; Text = '($w.Title)' }
        @{ Code = '$l = Get-PnPList -Identity x; ($l.ItemCount)++'; Text = '($l.ItemCount)' }
        @{ Code = '$_ = @{}; Get-PnPList | ForEach-Object { $_.Title = "x" }'; Text = '$_.Title' }
        @{ Code = '$PSItem = @{}; Get-PnPList | ForEach-Object { $PSItem.Title = "x" }'; Text = '$PSItem.Title' }
        @{ Code = '$h = @{}; Get-PnPList -PipelineVar h | ForEach-Object { $h.Title = "x" }'; Text = '$h.Title' }
        @{ Code = '$h = @{}; $n = "h"; Get-PnPList -PipelineVariable $n | ForEach-Object { $h.Title = "x" }'; Text = '$h.Title' }
        @{ Code = '$h = @{}; Get-PnPList -PipelineVariable script:h | ForEach-Object { $h.Title = "x" }'; Text = '$h.Title' }
        @{ Code = '$h = @{}; $p = @{ PipelineVariable = "h" }; Get-PnPList @p | ForEach-Object { $h.Title = "x" }'; Text = '$h.Title' }
        @{ Code = '$i = Get-PnPListItem -List x -Id 1; $i["Title"] = "x"'; Text = '$i["Title"]' }
        @{ Code = '$h = @{ a = @{} }; $h["a"]["b"] = 1'; Text = '$h["a"]["b"]' }
        @{ Code = '$row = [pscustomobject]@{ a = 1 }; $row.a = 2'; Text = '$row.a' }
        @{ Code = '(Get-PnPList).ForEach("Title", "x")'; Text = '(Get-PnPList).ForEach("Title", "x")' }
    )
    $methodRefused = @(
        @{ Code = '$w = Get-PnPWeb; $w.Update()'; Text = '.Update' }
        @{ Code = '$l = Get-PnPList -Identity x; $l.DeleteObject()'; Text = '.DeleteObject' }
        @{ Code = '$l = Get-PnPList -Identity x; $l.Recycle()'; Text = '.Recycle' }
        @{ Code = '$l = Get-PnPList -Identity x; $l.BreakRoleInheritance($true, $false)'; Text = '.BreakRoleInheritance' }
        @{ Code = '$w = Get-PnPWeb; $w.ResetRoleInheritance()'; Text = '.ResetRoleInheritance' }
        @{ Code = '$w = Get-PnPWeb; $w.EnsureUser("x")'; Text = '.EnsureUser' }
        @{ Code = '$g = Get-PnPGroup -Identity x; $g.Users.AddUser($u)'; Text = '.AddUser' }
        @{ Code = '$i = Get-PnPListItem -List x -Id 1; $i.SetFieldValue("Title", "x")'; Text = '.SetFieldValue' }
        @{ Code = '$i = Get-PnPListItem -List x -Id 1; $i.SystemUpdate()'; Text = '.SystemUpdate' }
        @{ Code = '$f = Get-PnPFile -Url x -AsListItem; $f.File.CheckOut()'; Text = '.CheckOut' }
        @{ Code = '$f = Get-PnPFile -Url x -AsListItem; $f.File.Publish("x")'; Text = '.Publish' }
        @{ Code = '$f = Get-PnPFile -Url x -AsListItem; $f.File.MoveTo("y", 1)'; Text = '.MoveTo' }
        @{ Code = 'Get-PnPList | ForEach-Object Update'; Text = '.Update' }
        @{ Code = 'Get-PnPList | ForEach-Object -MemberName DeleteObject'; Text = '.DeleteObject' }
        @{ Code = '(Get-PnPList).ForEach("Recycle")'; Text = '.Recycle' }
        @{ Code = '$w = Get-PnPWeb; $w.set_Title("x")'; Text = '.set_Title' }
        @{ Code = '$i = Get-PnPListItem -List x -Id 1; $i.ValidateUpdateListItem($v, $false, "")'; Text = '.ValidateUpdateListItem' }
        @{ Code = '$w = Get-PnPWeb; $w.RecycleBin.DeleteAll()'; Text = '.DeleteAll' }
        @{ Code = '$w = Get-PnPWeb; $w.RecycleBin.RestoreAll()'; Text = '.RestoreAll' }
        @{ Code = '$g = Get-PnPGroup -Identity x; $g.Users.RemoveById(1)'; Text = '.RemoveById' }
        @{ Code = '$f = Get-PnPFile -Url x -AsListItem; $f.File.StartUpload($id, $s)'; Text = '.StartUpload' }
        @{ Code = '$f = Get-PnPFile -Url x -AsListItem; $f.File.CopyTo("y", $true)'; Text = '.CopyTo' }
        @{ Code = '$w = Get-PnPWeb; $w.ApplyTheme($a, $b, $c, $true)'; Text = '.ApplyTheme' }
        @{ Code = '$w = Get-PnPWeb; $w.ShareObject($u, $p, $r, 0, $false, $false, $false, "", "", $false)'; Text = '.ShareObject' }
    )
    $wildcardRefused = @(
        @{ Code = 'Get-PnPList | ForEach-Object Upd*' }
        @{ Code = 'Get-PnPList | ForEach-Object -MemberName "DeleteObjec?"' }
        @{ Code = 'Get-PnPList | ForEach-Object "[R]ecycle"' }
    )
    $allowed = @(
        @{ Code = '$result = [ordered]@{ total = 0 }; $result.total = 3; $result.total++' }
        @{ Code = '$params = @{ Mailbox = "x" }; if ($true) { $params.IncludeHidden = $true }' }
        @{ Code = '$row = @{}; $row.name = (Get-PnPWeb).Title' }
        @{ Code = '$h = [ordered]@{}; $h["Title"] = "x"' }
        @{ Code = '$list = [System.Collections.Generic.List[object]]::new(); $list.Add(1)' }
        @{ Code = '$w = Get-PnPWeb; $title = $w.Title; $title += " (site)"' }
        @{ Code = '$n = 0; $n++; ++$n' }
        @{ Code = '$byLevel = @{}; $byLevel["a"] = 1; $byLevel["a"] += 1' }
        @{ Code = '$a, $b = 1, 2' }
        @{ Code = '$set = [System.Collections.Generic.HashSet[string]]::new(); $same = $set.SetEquals($set); $copy = @($set)' }
        @{ Code = '$e = @(1, 2).GetEnumerator(); while ($e.MoveNext()) { $e.Current }' }
        @{ Code = 'Get-PnPList | ForEach-Object Title' }
    )
}

BeforeAll {
    $runnerRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../portal/apps/runner')).Path
    Import-Module (Join-Path $runnerRoot 'ps/AdminForge.Runner/AdminForge.Runner.psd1') -Force
}

Describe 'Static read-only policy: client objects' {
    It 'refuses the property set in <Code>' -ForEach $setRefused {
        $findings = @(Test-AdminForgeReadOnlyScript -Content $Code)
        $finding = $findings | Where-Object Text -EQ $Text | Select-Object -First 1
        $finding | Should -Not -BeNullOrEmpty -Because "a finding for '$Text' (got: $($findings.Text -join ' | '))"
        $finding.Message | Should -BeLike "*Read-only scripts can set properties and indexes only on a variable the script assigns nothing but*(line $($finding.Line))"
    }

    It 'refuses the write method in <Code>' -ForEach $methodRefused {
        $findings = @(Test-AdminForgeReadOnlyScript -Content $Code)
        $finding = $findings | Where-Object Text -EQ $Text | Select-Object -First 1
        $finding | Should -Not -BeNullOrEmpty -Because "a finding for '$Text' (got: $($findings.Text -join ' | '))"
        $finding.Message | Should -BeLike "*can't call methods that change an object*"
    }

    It 'refuses the wildcard member name in <Code>' -ForEach $wildcardRefused {
        (@(Test-AdminForgeReadOnlyScript -Content $Code) | ForEach-Object Message) | Should -BeLike '*Members must be named exactly (no wildcards)*'
    }

    It 'allows <Code>' -ForEach $allowed {
        (@(Test-AdminForgeReadOnlyScript -Content $Code) | ForEach-Object Message) | Should -BeNullOrEmpty
    }
}
