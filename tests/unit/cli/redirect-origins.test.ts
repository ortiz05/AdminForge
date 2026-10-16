import { randomUUID } from 'node:crypto';
import { ConfigError } from '@adminforge/cli/src/shared/errors';
import { originProblem, provisionSettings } from '@adminforge/cli/src/provision/settings';
import { checkEnv } from '@adminforge/cli/src/env/env-check';

// Redirect URIs carry authorization codes: provisioning registers https origins, and http only on loopback.
const base = { AF_TENANT_ID: randomUUID() };

describe('redirect origins (PUBLIC_BASE_URL, AF_REDIRECT_BASE_URLS)', () => {
  it('accepts https anywhere and http on localhost, 127.0.0.1 and ::1', () => {
    for (const u of [
      'https://portal.example.com',
      'https://10.0.0.5:8443',
      'http://localhost:5173',
      'http://127.0.0.1:3300',
      'http://[::1]:3300',
      'http://LOCALHOST:5173',
    ])
      expect(originProblem(u)).toBeUndefined();
  });

  it('refuses http on any other host, other schemes, and garbage', () => {
    for (const u of ['http://10.0.0.5:8443', 'http://portal.example.com', 'http://localhost.example.com'])
      expect(originProblem(u)).toMatch(/must use https/);
    expect(originProblem('ftp://example.com')).toMatch(/http\(s\)/);
    expect(originProblem('not a url')).toBe('is not a valid URL');
  });

  it('provisionSettings refuses an http LAN origin in either key', () => {
    expect(() => provisionSettings({ ...base, PUBLIC_BASE_URL: 'http://10.0.0.5:5173' })).toThrow(
      ConfigError,
    );
    expect(() =>
      provisionSettings({
        ...base,
        AF_REDIRECT_BASE_URLS: 'http://localhost:3300, http://portal.example.com',
      }),
    ).toThrow(/AF_REDIRECT_BASE_URLS .*https/);
    expect(
      provisionSettings({ ...base, AF_REDIRECT_BASE_URLS: 'http://localhost:3300, https://10.0.0.5:8443' })
        .extraBaseUrls,
    ).toEqual(['http://localhost:3300', 'https://10.0.0.5:8443']);
  });

  it('env check reports the same rule and validates the ceiling opt-ins', () => {
    const example =
      'PUBLIC_BASE_URL=http://localhost:5173\nAF_REDIRECT_BASE_URLS=\nAF_ALLOW_PRIVILEGED_WRITE_SCOPES=false\n';
    const report = checkEnv(example, {
      PUBLIC_BASE_URL: 'http://portal.example.com',
      AF_REDIRECT_BASE_URLS: 'http://localhost:3300',
      AF_ALLOW_PRIVILEGED_WRITE_SCOPES: 'yes',
    });
    const state = Object.fromEntries(
      report.keys.map((k) => [k.key, `${k.state}${k.problem ? `: ${k.problem}` : ''}`]),
    );
    expect(state).toEqual({
      PUBLIC_BASE_URL: 'invalid: expected https (http only for localhost, 127.0.0.1 or ::1)',
      AF_REDIRECT_BASE_URLS: 'set',
      AF_ALLOW_PRIVILEGED_WRITE_SCOPES: 'invalid: expected true or false',
    });
  });
});
