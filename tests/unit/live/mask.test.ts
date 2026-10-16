import { mask, maskError, maskUrl, why } from '../../live/lib/mask';

// Live output masking (tests/live/lib/mask.ts): every message a live script prints goes through it.
const ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('mask', () => {
  it('hides object ids, addresses and UPNs, with or without a top-level domain', () => {
    expect(mask(`User ${ID} (avery@example.com) is not in group ${ID.toUpperCase()}.`)).toBe(
      'User <id> (<address>) is not in group <id>.',
    );
    expect(mask('The mailbox alias@contoso is not allowed to send as <ops@contoso.onmicrosoft.com>')).toBe(
      'The mailbox <address> is not allowed to send as <<address>>',
    );
  });

  it("hides the tenant's own Microsoft hosts but keeps Microsoft's", () => {
    expect(mask('Site https://contoso.sharepoint.com/sites/x and contoso-admin.sharepoint.com')).toBe(
      'Site https://<tenant>.sharepoint.com/sites/x and <tenant>.sharepoint.com',
    );
    expect(mask('Domain contoso.onmicrosoft.com via login.microsoftonline.com')).toBe(
      'Domain <tenant>.onmicrosoft.com via login.microsoftonline.com',
    );
  });

  it('leaves placeholders and package names alone', () => {
    expect(mask("could not resolve @dl:AF-Test-DL-01: Cannot find module '@adminforge/api'")).toBe(
      "could not resolve @dl:AF-Test-DL-01: Cannot find module '@adminforge/api'",
    );
  });
});

describe('maskError', () => {
  it('prints `code: message` with the message masked and cut', () => {
    expect(maskError({ code: 'graph_forbidden', message: `No access to ${ID} for avery@example.com.` })).toBe(
      'graph_forbidden: No access to <id> for <address>.',
    );
    expect(maskError({ code: 'x', message: 'a'.repeat(500) }, { max: 10 })).toBe('x: aaaaaaaaaa');
  });

  it('reads Error objects and plain strings, and keeps only the first sentence when asked', () => {
    expect(maskError(new Error('Access is denied. Check avery@example.com\nand retry.'))).toBe(
      'Access is denied. Check <address> and retry.',
    );
    expect(
      maskError('Access is denied. Mailbox avery@example.com is not allowed.', { firstSentence: true }),
    ).toBe('Access is denied.');
  });

  it('never dumps an object it does not understand', () => {
    expect(maskError({ upn: 'avery@example.com', id: ID })).toBe('error');
    expect(maskError(undefined)).toBe('error');
    expect(maskError({ code: 'only_code' })).toBe('only_code');
  });
});

describe('why', () => {
  it('is a masked ` — code: message` suffix, or nothing without an error', () => {
    expect(why({ code: 'failed', message: `Step for ${ID}` })).toBe(' — failed: Step for <id>');
    expect(why(undefined)).toBe('');
    expect(why({})).toBe('');
  });
});

describe('maskUrl', () => {
  it('drops the query and fragment and masks the path', () => {
    expect(
      maskUrl(`https://login.microsoftonline.com/${ID}/oauth2/v2.0/authorize?login_hint=a@b.com#x`),
    ).toBe('https://login.microsoftonline.com/<id>/oauth2/v2.0/authorize');
  });
});
