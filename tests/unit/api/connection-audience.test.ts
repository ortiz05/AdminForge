import { isMicrosoftResource } from '@adminforge/api/src/execution/outbound';

// Connections call your own APIs; a token for a Microsoft service must never go to a connection's host.
describe('isMicrosoftResource', () => {
  it.each([
    'https://graph.microsoft.com',
    'https://management.azure.com',
    'https://management.core.windows.net',
    'https://api.loganalytics.io',
    'https://outlook.office365.com',
    'https://contoso.sharepoint.com',
    'https://vault.azure.net',
    '00000003-0000-0000-c000-000000000000',
    '797F4846-BA00-4FD7-BA43-DAC1F8F63013',
  ])('blocks %s', (aud) => expect(isMicrosoftResource(aud)).toBe(true));

  it.each([
    'api://example-hr-sync',
    'api://11111111-2222-4333-8444-555555555555',
    '11111111-2222-4333-8444-555555555555',
    'https://hr-sync.azurewebsites.net',
    'https://api.example.com',
  ])('allows %s', (aud) => expect(isMicrosoftResource(aud)).toBe(false));
});
