#Requires -Version 7.4
# Format-AdminForgeMessage: service errors reach the browser as text, not as raw OData JSON or "|Exception.Type|"
# prefixes (Exchange Online REST and remote cmdlets). Applied to log events and to the worker's error event.

BeforeAll {
    $repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    Import-Module (Join-Path $repo 'portal/apps/runner/ps/AdminForge.Runner/AdminForge.Runner.psd1') -Force
}

Describe 'Format-AdminForgeMessage' {
    It 'keeps only the message of an Exchange Online OData error' {
        $raw = 'Could not read the permissions of ''kim@example.com'' on sales@example.com: An error occurred while processing this request.. ' +
        '{"error":{"code":"NotFound","message":"No permissions were found for the user:kim@example.com","innererror":{"message":"No permissions were found for the user:kim@example.com","type":"Microsoft.Exchange.Admin.OData.Core.ODataServiceException"}}}. ' +
        'An error was read from the payload. See the ''Error'' property for more details..'
        Format-AdminForgeMessage $raw | Should -Be 'Could not read the permissions of ''kim@example.com'' on sales@example.com: No permissions were found for the user:kim@example.com'
    }

    It 'unescapes JSON in the message' {
        Format-AdminForgeMessage 'Failed: {"error":{"code":"X","message":"Say \"hi\"\nnow"}}' | Should -Be "Failed: Say `"hi`"`nnow"
    }

    It 'drops the exception type Exchange puts in front of remote cmdlet errors' {
        Format-AdminForgeMessage "||The operation couldn't be performed because object: 'sales\123' couldn't be found." |
            Should -Be "The operation couldn't be performed because object: 'sales\123' couldn't be found."
        Format-AdminForgeMessage "Could not add kim@example.com: |Microsoft.Exchange.Configuration.Tasks.ManagementObjectNotFoundException|The object couldn't be found.." |
            Should -Be "Could not add kim@example.com: The object couldn't be found."
    }

    It 'leaves ordinary text, pipes inside text and empty values alone' {
        Format-AdminForgeMessage 'Read 12 mailboxes' | Should -Be 'Read 12 mailboxes'
        Format-AdminForgeMessage 'a | b' | Should -Be 'a | b'
        Format-AdminForgeMessage '' | Should -Be ''
        Format-AdminForgeMessage $null | Should -BeNullOrEmpty
    }

    It 'is applied to log events' {
        $events = [System.Collections.Generic.List[object]]::new()
        Set-AdminForgeEventSink -ScriptBlock { param($e) $events.Add($e) }.GetNewClosure()
        try {
            Write-AdminForgeLog -Level Warn 'Could not resolve trustee: ||The object couldn''t be found.'
        } finally {
            Set-AdminForgeEventSink -Reset
        }
        $events[0].message | Should -Be 'Could not resolve trustee: The object couldn''t be found.'
    }
}
