import { createHttpClient, FORBIDDEN_HEADERS, isForbiddenHeader } from '@adminforge/connectors';
import { fakeFetch, headersOf } from './fake-fetch';

// S-02: headers a caller (content) passes can never replace or double the bearer token, the correlation id or the
// other headers AdminForge owns — in any letter case.

const client = (extra = {}) => {
  const f = fakeFetch([{ status: 200, body: {} }]);
  const http = createHttpClient({
    getToken: async () => 'REAL',
    fetch: f.fetch,
    sleep: async () => undefined,
    correlationId: 'corr-1',
    correlationHeader: 'client-request-id',
    ...extra,
  });
  return { f, http };
};

/** Every header sent, by lower-case name (so a doubled value under two spellings shows up). */
const sentHeaders = (h: Record<string, string>) => {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(h)) (out[k.toLowerCase()] ??= []).push(v);
  return out;
};

describe('createHttpClient: caller headers', () => {
  it.each([
    ['Authorization', 'Bearer EVIL'],
    ['authorization', 'Bearer EVIL'],
    ['AUTHORIZATION', 'Bearer EVIL'],
  ])('a caller %s header neither replaces nor doubles the bearer', async (name, value) => {
    const { f, http } = client();
    await http.send({ url: 'https://graph.microsoft.com/v1.0/me', headers: { [name]: value } });
    const sent = sentHeaders(headersOf(f.calls[0]!));
    expect(sent.authorization).toEqual(['Bearer REAL']);
  });

  it('a caller correlation header (either spelling, any case) cannot spoof the correlation id', async () => {
    const { f, http } = client();
    await http.send({
      url: 'https://graph.microsoft.com/v1.0/me',
      headers: { 'Client-Request-Id': 'spoofed', 'x-ms-client-request-id': 'spoofed-too' },
    });
    const sent = sentHeaders(headersOf(f.calls[0]!));
    expect(sent['client-request-id']).toEqual(['corr-1']);
    expect(sent['x-ms-client-request-id']).toBeUndefined();
  });

  it('drops cookie, proxy-authorization and host from the caller', async () => {
    const { f, http } = client();
    await http.send({
      url: 'https://graph.microsoft.com/v1.0/me',
      headers: { Cookie: 'a=b', 'Proxy-Authorization': 'Basic x', HOST: 'evil.example' },
    });
    const sent = sentHeaders(headersOf(f.calls[0]!));
    expect(sent.cookie).toBeUndefined();
    expect(sent['proxy-authorization']).toBeUndefined();
    expect(sent.host).toBeUndefined();
  });

  it('keeps the headers content may set (ConsistencyLevel, Prefer) and lets them choose Accept once', async () => {
    const { f, http } = client();
    await http.send({
      url: 'https://graph.microsoft.com/v1.0/users',
      headers: { ConsistencyLevel: 'eventual', Prefer: 'odata.maxpagesize=999', accept: 'text/csv' },
    });
    const sent = sentHeaders(headersOf(f.calls[0]!));
    expect(sent.consistencylevel).toEqual(['eventual']);
    expect(sent.prefer).toEqual(['odata.maxpagesize=999']);
    expect(sent.accept).toEqual(['text/csv']);
    expect(sent.authorization).toEqual(['Bearer REAL']);
  });

  it('names the forbidden list once, case-insensitively', () => {
    expect([...FORBIDDEN_HEADERS].sort()).toEqual(
      [
        'authorization',
        'client-request-id',
        'cookie',
        'host',
        'proxy-authorization',
        'x-ms-client-request-id',
        // Method overrides (S-23): the policy judges the method a request is sent with.
        'x-http-method',
        'x-http-method-override',
        'x-method-override',
      ].sort(),
    );
    expect(isForbiddenHeader('AuThOrIzAtIoN')).toBe(true);
    expect(isForbiddenHeader(' authorization ')).toBe(true);
    expect(isForbiddenHeader('ConsistencyLevel')).toBe(false);
  });
});
