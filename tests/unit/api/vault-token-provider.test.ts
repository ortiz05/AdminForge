import {
  createAppIdentityRegistry,
  createAutomationTokenProvider,
  type ClientCredentialClient,
} from '@adminforge/api/src/auth/automation';
import { VaultClient, VaultCredentials } from '@adminforge/api/src/auth/vault';
import { fakeVault } from '../../support/vault/fake-vault';

// App-only tokens with credentials from Vault (ADR-018): the env file holds only the client ids; the secret comes from
// <path>/identities/<name>, a rotation is picked up when Entra rejects the old one, and errors name the path, never a
// value.
const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '66666666-7777-4888-8999-000000000000';
const IDENTITY_CLIENT = '66666666-7777-4888-8999-000000000001';
const SECRET = 'synthetic-vault-secret';
const PATH = 'secret/adminforge/dev/identities';

function msal(fail?: (secret: unknown) => Error | null) {
  const configs: Array<{ auth: Record<string, unknown> }> = [];
  const createClient = (config: { auth: Record<string, unknown> }): ClientCredentialClient => {
    configs.push(config);
    return {
      acquireTokenByClientCredential: async () => {
        const e = fail?.(config.auth.clientSecret);
        if (e) throw e;
        return { accessToken: `token-for-${String(config.auth.clientSecret)}` };
      },
    };
  };
  return { createClient: createClient as never, configs };
}

function setup() {
  let t = Date.parse('2026-10-23T12:00:00Z');
  const now = () => t;
  const vault = fakeVault({ now });
  const client = new VaultClient(
    {
      addr: 'https://vault.example.com',
      auth: 'kubernetes',
      authMount: 'kubernetes',
      role: 'adminforge',
      k8sTokenFile: '/sa/token',
      kvMount: 'secret',
      path: 'adminforge/dev',
      refreshSeconds: 300,
    },
    { fetch: vault.fetch, readFile: () => 'k8s-jwt', now },
  );
  const creds = new VaultCredentials(client, ['automation', 'reports-team'], { refreshSeconds: 300, now });
  return { vault, creds, advance: (ms: number) => (t += ms) };
}

describe('tokens with credentials from Vault', () => {
  it('needs no secret in the env file: it signs in with the one in Vault', async () => {
    const { vault, creds } = setup();
    vault.put(`${PATH}/automation`, { client_id: CLIENT, client_secret: SECRET });
    const m = msal();
    const p = createAutomationTokenProvider(
      { AF_TENANT_ID: TENANT, AF_AUTOMATION_CLIENT_ID: CLIENT },
      { createClient: m.createClient, vault: creds },
    )!;
    expect(p).not.toBeNull();
    expect(await p.token('https://graph.microsoft.com/.default')).toBe(`token-for-${SECRET}`);
    expect(p.credential).toBe('secret');
  });

  it('says where the missing or mismatched credential belongs, without a value', async () => {
    const { vault, creds } = setup();
    const p = createAutomationTokenProvider(
      { AF_TENANT_ID: TENANT, AF_AUTOMATION_CLIENT_ID: CLIENT },
      { createClient: msal().createClient, vault: creds },
    )!;
    await expect(p.token('https://graph.microsoft.com/.default')).rejects.toMatchObject({
      code: 'credential_unavailable',
      message: 'The automation identity has no credential in Vault (identities/automation).',
    });
    vault.put(`${PATH}/automation`, { client_id: IDENTITY_CLIENT, client_secret: SECRET });
    await creds.refresh();
    const err = await p.token('https://graph.microsoft.com/.default').catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'credential_mismatch' });
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it('picks up a secret rotated in Vault when Entra rejects the old one', async () => {
    const { vault, creds, advance } = setup();
    vault.put(`${PATH}/automation`, { client_secret: 'old-secret' });
    const m = msal((secret) =>
      secret === 'old-secret'
        ? Object.assign(new Error('x'), { errorMessage: 'AADSTS7000215: Invalid client secret provided.' })
        : null,
    );
    const p = createAutomationTokenProvider(
      { AF_TENANT_ID: TENANT, AF_AUTOMATION_CLIENT_ID: CLIENT },
      { createClient: m.createClient, vault: creds },
    )!;
    await creds.refresh();
    vault.put(`${PATH}/automation`, { client_secret: 'new-secret' });
    advance(31_000);
    expect(await p.token('https://graph.microsoft.com/.default')).toBe('token-for-new-secret');
    expect(m.configs.map((c) => c.auth.clientSecret)).toEqual(['old-secret', 'new-secret']);
  });

  it('gives named app identities their own path', async () => {
    const { vault, creds } = setup();
    vault.put(`${PATH}/reports-team`, { client_secret: 'team-secret' });
    const registry = createAppIdentityRegistry(
      {
        AF_TENANT_ID: TENANT,
        AF_AUTOMATION_CLIENT_ID: CLIENT,
        SCHEDULE_IDENTITIES: [{ name: 'reports-team', clientId: IDENTITY_CLIENT }],
      },
      { createClient: msal().createClient, vault: creds },
    );
    expect(await registry.get('reports-team')!.token('https://graph.microsoft.com/.default')).toBe(
      'token-for-team-secret',
    );
  });
});
