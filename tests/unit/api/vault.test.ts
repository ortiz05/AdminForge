import {
  VaultClient,
  VaultCredentials,
  vaultSettings,
  type VaultSettings,
} from '@adminforge/api/src/auth/vault';
import { fakeVault } from '../../support/vault/fake-vault';

// Credentials from HashiCorp Vault (ADR-018), against a stand-in Vault: each login method, the namespace header, KV v2
// reads, token renewal and re-login, rotation, outages (the last good credentials stay), and no value in any error.
const base: VaultSettings = {
  addr: 'https://vault.example.com',
  auth: 'kubernetes',
  authMount: 'kubernetes',
  role: 'adminforge',
  k8sTokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  kvMount: 'secret',
  path: 'adminforge/dev',
  refreshSeconds: 300,
};
const files: Record<string, string> = {
  '/var/run/secrets/kubernetes.io/serviceaccount/token': 'k8s-jwt\n',
  '/etc/vault/secret-id': 'secret-id',
  '/etc/vault/token': 'hvs.static',
};
const readFile = (p: string) => {
  if (!(p in files)) throw new Error('ENOENT');
  return files[p]!;
};
const SECRET = 'synthetic-client-secret-value';

function setup(settings: Partial<VaultSettings> = {}, vaultOpts: Parameters<typeof fakeVault>[0] = {}) {
  let t = Date.parse('2026-10-23T12:00:00Z');
  const now = () => t;
  const vault = fakeVault({ now, ...vaultOpts });
  const client = new VaultClient({ ...base, ...settings }, { fetch: vault.fetch, readFile, now });
  return { vault, client, now, advance: (ms: number) => (t += ms) };
}

describe('VaultClient', () => {
  it('logs in with the service-account token and reads an identity, with the namespace header', async () => {
    const { vault, client } = setup({ namespace: 'ops' }, { namespace: 'ops' });
    vault.put('secret/adminforge/dev/identities/automation', { client_id: 'app-id', client_secret: SECRET });
    expect(await client.readIdentity('automation')).toEqual({
      clientId: 'app-id',
      clientSecret: SECRET,
      version: 1,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(vault.calls.map((c) => `${c.method} ${c.path} ${c.namespace}`)).toEqual([
      'POST auth/kubernetes/login ops',
      'GET secret/data/adminforge/dev/identities/automation ops',
    ]);
    expect(await client.readIdentity('reports-team')).toBeNull();
  });

  it('logs in with AppRole, or uses a token file', async () => {
    const approle = setup({
      auth: 'approle',
      authMount: 'approle',
      roleId: 'role-id',
      secretIdFile: '/etc/vault/secret-id',
    });
    approle.vault.put('secret/adminforge/dev/identities/automation', { client_secret: SECRET });
    expect(await approle.client.readIdentity('automation')).toMatchObject({ clientSecret: SECRET });
    expect(approle.vault.calls[0]).toMatchObject({ method: 'POST', path: 'auth/approle/login' });

    const token = setup({ auth: 'token', tokenFile: '/etc/vault/token' }, { staticToken: 'hvs.static' });
    token.vault.put('secret/adminforge/dev/identities/automation', {
      certificate_pem: '-----BEGIN CERTIFICATE-----',
    });
    expect(await token.client.readIdentity('automation')).toMatchObject({
      certificatePem: expect.any(String),
    });
    expect(token.vault.calls[0]).toMatchObject({ path: 'auth/token/lookup-self', token: 'hvs.static' });
  });

  it('renews its token before it expires, and logs in again when it was revoked', async () => {
    const { vault, client, advance } = setup({}, { ttlSeconds: 600 });
    vault.put('secret/adminforge/dev/identities/automation', { client_secret: SECRET });
    await client.readIdentity('automation');
    advance(450_000); // past two thirds of the lease
    await client.readIdentity('automation');
    expect(vault.calls.map((c) => c.path)).toContain('auth/token/renew-self');
    vault.revokeAll();
    expect(await client.readIdentity('automation')).toMatchObject({ clientSecret: SECRET });
    expect(vault.calls.filter((c) => c.path === 'auth/kubernetes/login')).toHaveLength(2);
  });

  it('says what failed — path and status, never a value', async () => {
    const refused = setup({ role: 'someone-else' });
    const e1 = await refused.client.readIdentity('automation').catch((e: Error) => e);
    expect(String(e1)).toMatch(/refused the Kubernetes login at auth\/kubernetes \(HTTP 403\)/);
    const down = setup();
    down.vault.setDown(true);
    const e2 = await down.client.readIdentity('automation').catch((e: Error) => e);
    expect(String(e2)).toMatch(/could not be reached/);
    const noFile = setup({ k8sTokenFile: '/nope' });
    expect(String(await noFile.client.readIdentity('automation').catch((e: Error) => e))).toMatch(
      /AF_VAULT_K8S_TOKEN_FILE cannot be read/,
    );
    for (const e of [e1, e2]) expect(String(e)).not.toContain('k8s-jwt');
  });
});

describe('VaultCredentials', () => {
  it('loads every identity, keeps the last good ones through an outage, and picks up a rotation', async () => {
    const { vault, client, now, advance } = setup();
    vault.put('secret/adminforge/dev/identities/automation', { client_secret: SECRET });
    const logs: unknown[] = [];
    const creds = new VaultCredentials(client, ['automation', 'reports-team'], {
      refreshSeconds: 300,
      now,
      log: { warn: (o) => void logs.push(o) },
    });
    expect(await creds.ensure('automation')).toMatchObject({ clientSecret: SECRET, version: 1 });
    expect(creds.status()).toMatchObject({
      identities: { automation: 'loaded', 'reports-team': 'missing' },
      errors: {},
    });

    vault.setDown(true);
    await creds.refresh();
    expect(creds.current('automation')).toMatchObject({ clientSecret: SECRET });
    expect(creds.status()).toMatchObject({
      identities: { automation: 'stale' },
      errors: { automation: expect.stringMatching(/could not be reached/) },
    });
    expect(JSON.stringify(logs)).not.toContain(SECRET);

    vault.setDown(false);
    vault.put('secret/adminforge/dev/identities/automation', { client_secret: 'rotated-secret' });
    advance(31_000);
    expect(await creds.refreshNow('automation')).toMatchObject({
      clientSecret: 'rotated-secret',
      version: 2,
    });
    // A second forced read within 30 s doesn't call Vault again.
    const before = vault.calls.length;
    await creds.refreshNow('automation');
    expect(vault.calls.length).toBe(before);
  });
});

describe('vaultSettings', () => {
  it('is off without AF_VAULT_ADDR, and defaults the path from the environment label', () => {
    expect(vaultSettings({ AF_ENV_LABEL: 'prod' })).toBeNull();
    expect(
      vaultSettings({
        AF_ENV_LABEL: 'prod',
        AF_VAULT_ADDR: 'https://vault.example.com/',
        AF_VAULT_ROLE: 'adminforge',
      } as never),
    ).toMatchObject({
      addr: 'https://vault.example.com',
      auth: 'kubernetes',
      authMount: 'kubernetes',
      kvMount: 'secret',
      path: 'adminforge/prod',
      refreshSeconds: 300,
    });
  });
});
