import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createAutomationTokenProvider,
  type ClientCredentialClient,
} from '@adminforge/api/src/auth/automation';
import { VaultClient, VaultCredentials, type VaultSettings } from '@adminforge/api/src/auth/vault';
import { fakeVault, type FakeVaultOptions } from '../../support/vault/fake-vault';

// What the security review of credentials from Vault (ADR-018) asked for: redirects are never followed (the token would
// go with them), one identity Vault refuses leaves the others alone and doesn't start a new login, an identity with
// nothing loaded doesn't send every run to Vault, a 404 that isn't Vault's own keeps the last good credential, a token
// AdminForge replaces is revoked, and a secret written again at the same version is still picked up.
const base: VaultSettings = {
  addr: 'https://vault.example.com',
  auth: 'kubernetes',
  authMount: 'kubernetes',
  role: 'adminforge',
  k8sTokenFile: '/var/run/secrets/vault/token',
  kvMount: 'secret',
  path: 'adminforge/dev',
  refreshSeconds: 300,
};
const PATH = 'secret/data/adminforge/dev/identities';
const NAMES = ['automation', 'reports-team', 'intune-ops'];

function setup(vaultOpts: FakeVaultOptions = {}) {
  let t = Date.parse('2026-10-23T12:00:00Z');
  const now = () => t;
  const vault = fakeVault({ now, ...vaultOpts });
  let attempts = 0;
  const fetch: typeof vault.fetch = (url, init) => {
    attempts++;
    return vault.fetch(url, init);
  };
  const client = new VaultClient(base, { fetch, readFile: () => 'k8s-jwt', now });
  const logs: Array<[string, object]> = [];
  const creds = new VaultCredentials(client, NAMES, {
    refreshSeconds: 300,
    now,
    log: { warn: (o, m) => void logs.push([m, o]), info: (o, m) => void logs.push([m, o]) },
  });
  for (const n of NAMES)
    vault.put(`secret/adminforge/dev/identities/${n}`, { client_secret: `secret-of-${n}` });
  const logins = () => vault.calls.filter((c) => c.path === 'auth/kubernetes/login').length;
  return { vault, client, creds, logs, logins, attempts: () => attempts, advance: (ms: number) => (t += ms) };
}

describe('Vault redirects', () => {
  const servers: Server[] = [];
  const listen = (handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void) =>
    new Promise<string>((resolve) => {
      const s = createServer(handler).listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
      );
      servers.push(s);
    });
  afterAll(() => servers.forEach((s) => s.close()));

  it('are never followed, so the token stays with Vault', async () => {
    const elsewhere: Array<{ token?: string | string[]; url?: string }> = [];
    const other = await listen((req, res) => {
      elsewhere.push({ token: req.headers['x-vault-token'], url: req.url });
      res.end('{}');
    });
    const vaultAddr = await listen((req, res) => {
      res.writeHead(307, { location: `${other}${req.url}` }).end();
    });
    const client = new VaultClient(
      { ...base, addr: vaultAddr, auth: 'token', tokenFile: '/etc/vault/token' },
      { readFile: () => 'hvs.synthetic-token' },
    );
    const err = await client.readIdentity('automation').catch((e: Error) => e);
    expect(String(err)).toMatch(/with a redirect \(HTTP 307\), which AdminForge doesn't follow/);
    expect(String(err)).not.toContain('hvs.synthetic-token');
    expect(elsewhere).toEqual([]);
  });
});

describe('VaultCredentials when one identity fails', () => {
  it('loads the others, and doesn’t log in again for a path the policy doesn’t grant', async () => {
    const { vault, creds, logs, logins } = setup();
    vault.deny(`${PATH}/reports-team`);
    await creds.refresh();
    expect(creds.status()).toMatchObject({
      identities: { automation: 'loaded', 'reports-team': 'unavailable', 'intune-ops': 'loaded' },
      errors: { 'reports-team': expect.stringMatching(/policy for AdminForge doesn't grant this path/) },
    });
    await creds.refresh();
    expect(logins()).toBe(1);
    expect(logs.filter(([m]) => m === 'vault refresh failed')).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain('secret-of-');
  });

  it('doesn’t send every run of an identity with nothing loaded to Vault', async () => {
    const { vault, creds, advance } = setup();
    vault.deny(`${PATH}/reports-team`);
    const reads = () => vault.calls.filter((c) => c.path === `${PATH}/reports-team`).length;
    for (let i = 0; i < 5; i++) expect(await creds.ensure('reports-team')).toBeNull();
    expect(reads()).toBe(1);
    advance(31_000);
    await creds.ensure('reports-team');
    expect(reads()).toBe(2);
  });

  it('stops the round when Vault itself is down, and keeps what it had', async () => {
    const { vault, creds, attempts } = setup();
    await creds.refresh();
    vault.setDown(true);
    const before = attempts();
    await creds.refresh();
    expect(attempts() - before).toBe(1);
    expect(creds.status().identities).toEqual({
      automation: 'stale',
      'reports-team': 'stale',
      'intune-ops': 'stale',
    });
    expect(creds.current('intune-ops')).toMatchObject({ clientSecret: 'secret-of-intune-ops' });
  });

  it('keeps the last good credential through a 404 that isn’t Vault’s own', async () => {
    const { vault, creds } = setup();
    await creds.refresh();
    vault.foreign404(`${PATH}/automation`);
    await creds.refresh();
    expect(creds.status().identities.automation).toBe('stale');
    expect(creds.current('automation')).toMatchObject({ clientSecret: 'secret-of-automation' });
    vault.remove('secret/adminforge/dev/identities/reports-team');
    await creds.refresh();
    expect(creds.status().identities['reports-team']).toBe('missing');
  });
});

describe('VaultClient tokens', () => {
  it('revokes the token it replaces', async () => {
    const { vault, client, advance } = setup({ ttlSeconds: 600, renewable: false });
    await client.readIdentity('automation');
    advance(450_000);
    await client.readIdentity('automation');
    await new Promise((r) => setTimeout(r, 0));
    expect(vault.calls.map((c) => c.path)).toContain('auth/token/revoke-self');
    expect(vault.liveTokens()).toHaveLength(1);
  });

  it('never follows a redirect with the token, by asking fetch not to', async () => {
    const { vault, client } = setup();
    await client.readIdentity('automation');
    expect(new Set(vault.calls.map((c) => c.redirect))).toEqual(new Set(['manual']));
  });
});

describe('a secret written again at the same version', () => {
  it('is picked up when Entra rejects the old one', async () => {
    const { vault, creds, advance } = setup();
    const configs: Array<Record<string, unknown>> = [];
    const createClient = (config: { auth: Record<string, unknown> }): ClientCredentialClient => {
      configs.push(config.auth);
      return {
        acquireTokenByClientCredential: async () => {
          if (config.auth.clientSecret === 'secret-of-automation')
            throw Object.assign(new Error('x'), {
              errorMessage: 'AADSTS7000215: Invalid client secret provided.',
            });
          return { accessToken: `token-for-${String(config.auth.clientSecret)}` };
        },
      };
    };
    const p = createAutomationTokenProvider(
      {
        AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
        AF_AUTOMATION_CLIENT_ID: '66666666-7777-4888-8999-000000000000',
      },
      { vault: creds, createClient: createClient as never },
    )!;
    await creds.refresh();
    // `vault kv metadata delete` then `kv put`: the new secret is version 1 again.
    vault.remove('secret/adminforge/dev/identities/automation');
    vault.put('secret/adminforge/dev/identities/automation', { client_secret: 'rewritten-secret' });
    advance(31_000);
    expect(await p.token('https://graph.microsoft.com/.default')).toBe('token-for-rewritten-secret');
    expect(configs.map((c) => c.clientSecret)).toEqual(['secret-of-automation', 'rewritten-secret']);
  });
});
