import { loadConfig } from '@adminforge/api/src/config';

// Vault paths and the token for Vault (ADR-018, from the security review): a mount or path with `.`/`..` segments (URL
// normalisation would resolve them, e.g. to /v1/sys/…) is refused — also when AF_ENV_LABEL names the default path —
// and in production the token for Vault is a projected one, never the pod's Kubernetes API token.
const base = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://adminforge.example.com',
  AUTH_MODE: 'entra',
  AF_TENANT_ID: '00000000-0000-4000-8000-000000000000',
  AF_READ_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
  AF_READ_CLIENT_SECRET: 'synthetic-read-secret',
  TOKEN_CACHE_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
  AF_AUTOMATION_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  AF_VAULT_ADDR: 'https://vault.example.com',
  AF_VAULT_ROLE: 'adminforge',
};

describe('Vault paths and token file', () => {
  it('defaults to the projected token for Vault', () => {
    expect(loadConfig(base).AF_VAULT_K8S_TOKEN_FILE).toBe('/var/run/secrets/vault/token');
  });

  it.each([
    [{ AF_VAULT_PATH: 'adminforge/../../sys/mounts' }, 'AF_VAULT_PATH: must be names'],
    [{ AF_VAULT_PATH: 'adminforge/./prod' }, 'AF_VAULT_PATH: must be names'],
    [{ AF_VAULT_KV_MOUNT: 'secret/..' }, 'AF_VAULT_KV_MOUNT: must be names'],
    [{ AF_ENV_LABEL: 'prod?x=1' }, 'AF_ENV_LABEL: names the default AF_VAULT_PATH'],
    [
      { AF_VAULT_K8S_TOKEN_FILE: '/var/run/secrets/kubernetes.io/serviceaccount/token' },
      'AF_VAULT_K8S_TOKEN_FILE: use a projected token for Vault',
    ],
  ])('refuses %j', (extra, problem) => {
    expect(() => loadConfig({ ...base, ...extra })).toThrow(problem);
  });

  it('accepts a nested path and mount', () => {
    expect(
      loadConfig({ ...base, AF_VAULT_KV_MOUNT: 'kv/platform', AF_VAULT_PATH: 'teams/adminforge.prod' }),
    ).toMatchObject({ AF_VAULT_KV_MOUNT: 'kv/platform', AF_VAULT_PATH: 'teams/adminforge.prod' });
  });
});
