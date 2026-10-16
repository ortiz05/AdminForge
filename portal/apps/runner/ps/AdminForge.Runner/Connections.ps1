<#
    AdminForge.Runner — connections. Dot-sourced by AdminForge.Runner.psm1 into the module's scope (which sets strict
    mode); not loaded on its own.

    Connect-AdminForgeServices connects Microsoft Graph, Exchange Online, Teams, SharePoint (PnP) and Az with the
    calling engineer's forwarded delegated tokens, before the job script runs (scripts never connect themselves).
    Tokens arrive in the job and are never persisted or logged; the token claims are decoded only for labels (UPN,
    object id), never trusted for authorization. Connection failures surface as 'auth' errors (Errors.ps1).
#>

#region Connections

function Get-AdminForgeTokenClaims {
    <# Decodes (without validating) the payload of a JWT access token. Used only for labels such as the UPN. #>
    param([string]$Token)
    try {
        $parts = $Token.Split('.')
        if ($parts.Count -lt 2) { return @{} }
        $payload = $parts[1].Replace('-', '+').Replace('_', '/')
        switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } }
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
        ConvertFrom-Json -InputObject $json -AsHashtable
    } catch {
        @{}
    }
}

function Get-AdminForgeUserFromClaims {
    param([System.Collections.IDictionary]$Claims)
    $upn = $null
    foreach ($claim in 'upn', 'preferred_username', 'unique_name') {
        if ($Claims.Contains($claim) -and $Claims[$claim]) { $upn = [string]$Claims[$claim]; break }
    }
    $oid = if ($Claims.Contains('oid')) { [string]$Claims['oid'] } else { $null }
    @{ Upn = $upn; ObjectId = $oid }
}

function Connect-AdminForgeServices {
    <#
    .SYNOPSIS
        Connects the requested services with the calling engineer's forwarded delegated tokens.
    .DESCRIPTION
        $Context = @{
            Mode   = 'read' | 'write'
            Tenant = @{ id = '<guid>'; domain = 'contoso.onmicrosoft.com'; spoTenantName = 'contoso' }
            Tokens = @{ graph = '...'; exchange = '...'; teams = '...'; sharepointAdmin = '...'; arm = '...' }
        }
        Services and the tokens they need:
            Graph       graph                Connect-MgGraph -AccessToken <SecureString>
            Exchange    exchange             Connect-ExchangeOnline -AccessToken -Organization <tenant domain>
            Teams       graph + teams        Connect-MicrosoftTeams -AccessTokens @(graph, teams)
            SharePoint  sharepointAdmin      Connect-PnPOnline -Url https://<spoTenantName>-admin.sharepoint.com -AccessToken
            Az          arm                  Connect-AzAccount -AccessToken -AccountId <upn> -Tenant <id> -Scope Process
        Nothing is persisted: Az context autosave is disabled and the worker runs with a throw-away HOME.
        Returns @{ Services = <connected>; User = @{ Upn; ObjectId } }.
    .EXAMPLE
        Connect-AdminForgeServices -Context $ctx -Services Graph, Exchange
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Context,
        [Parameter(Mandatory)][ValidateSet('Graph', 'Exchange', 'Teams', 'SharePoint', 'Az')][string[]]$Services
    )
    $tokens = if ($Context.Contains('Tokens') -and $Context['Tokens']) { $Context['Tokens'] } else { @{} }
    $tenant = if ($Context.Contains('Tenant') -and $Context['Tenant']) { $Context['Tenant'] } else { @{} }
    $token = {
        param([string]$Name, [string]$Service)
        if (-not $tokens.Contains($Name) -or [string]::IsNullOrEmpty([string]$tokens[$Name])) {
            throw (New-AdminForgeError -Category auth -Message "$Service needs a '$Name' token, but none was forwarded for this job." -ErrorId 'AdminForge.TokenMissing')
        }
        [string]$tokens[$Name]
    }
    $tenantValue = {
        param([string]$Name, [string]$Service)
        if (-not $tenant.Contains($Name) -or [string]::IsNullOrEmpty([string]$tenant[$Name])) {
            throw (New-AdminForgeError -Category auth -Message "$Service needs tenant.$Name." -ErrorId 'AdminForge.TenantValueMissing')
        }
        [string]$tenant[$Name]
    }

    $user = @{ Upn = $null; ObjectId = $null }
    foreach ($name in 'graph', 'exchange', 'teams', 'sharepointAdmin', 'arm') {
        if ($tokens.Contains($name) -and $tokens[$name]) {
            $user = Get-AdminForgeUserFromClaims (Get-AdminForgeTokenClaims ([string]$tokens[$name]))
            if ($user.Upn -or $user.ObjectId) { break }
        }
    }

    $connected = [System.Collections.Generic.List[string]]::new()
    # SharePoint first: PnP.PowerShell must be imported before MicrosoftTeams (assembly resolver conflict).
    $order = 'SharePoint', 'Graph', 'Exchange', 'Teams', 'Az'
    foreach ($service in ($order | Where-Object { $_ -in $Services })) {
        try {
            switch ($service) {
                'Graph' {
                    $secure = ConvertTo-SecureString -String (& $token 'graph' 'Graph') -AsPlainText -Force
                    Connect-MgGraph -AccessToken $secure -NoWelcome -ErrorAction Stop | Out-Null
                }
                'Exchange' {
                    $params = @{
                        AccessToken           = (& $token 'exchange' 'Exchange Online')
                        Organization          = (& $tenantValue 'domain' 'Exchange Online')
                        ShowBanner            = $false
                        SkipLoadingFormatData = $true
                        SkipLoadingCmdletHelp = $true
                        ErrorAction           = 'Stop'
                    }
                    if ($user.Upn) { $params.UserPrincipalName = $user.Upn }
                    Connect-ExchangeOnline @params | Out-Null
                }
                'Teams' {
                    # The tenant comes from the tokens: MicrosoftTeams 8 refuses -TenantId together with -AccessTokens
                    # ("Not supported tenant type").
                    $teamsTokens = @((& $token 'graph' 'Microsoft Teams'), (& $token 'teams' 'Microsoft Teams'))
                    Connect-MicrosoftTeams -AccessTokens $teamsTokens -ErrorAction Stop | Out-Null
                }
                'SharePoint' {
                    $name = & $tenantValue 'spoTenantName' 'SharePoint'
                    if ($name -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
                        throw (New-AdminForgeError -Category input -Message 'tenant.spoTenantName is not a valid SharePoint tenant name.')
                    }
                    Connect-PnPOnline -Url "https://$name-admin.sharepoint.com" -AccessToken (& $token 'sharepointAdmin' 'SharePoint') -ErrorAction Stop | Out-Null
                }
                'Az' {
                    $accountId = if ($user.Upn) { $user.Upn } elseif ($user.ObjectId) { $user.ObjectId } else { 'adminforge-user' }
                    Disable-AzContextAutosave -Scope Process -WarningAction SilentlyContinue | Out-Null
                    $params = @{
                        AccessToken   = (& $token 'arm' 'Azure')
                        AccountId     = $accountId
                        Scope         = 'Process'
                        ErrorAction   = 'Stop'
                        WarningAction = 'SilentlyContinue'
                    }
                    if ($tenant.Contains('id') -and $tenant['id']) { $params.Tenant = [string]$tenant['id'] }
                    Connect-AzAccount @params | Out-Null
                }
            }
            $connected.Add($service)
        } catch {
            $category = Get-AdminForgeErrorCategory $_
            if ($category -eq 'script') { $category = 'auth' }
            throw (New-AdminForgeError -Category $category -Message "Could not connect to ${service}: $($_.Exception.Message)" -ErrorId 'AdminForge.ConnectFailed')
        }
    }
    @{ Services = $connected.ToArray(); User = $user }
}

#endregion
