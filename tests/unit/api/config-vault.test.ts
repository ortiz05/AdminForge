import { loadConfig } from '@adminforge/api/src/config';

// Credentials from Vault (AF_VAULT_*; ADR-018): an https address, the settings its login method needs, and one source —
// with Vault on, the env file holds no client secret or certificate path. Problems name keys, never values.
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

describe('AF_VAULT_*', () => {
  it('starts with Vault holding the credentials: no secret in the env file, identities without one', () => {
    const cfg = loadConfig({
      ...base,
      AF_SCHEDULE_IDENTITIES: 'reports-team',
      AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
    });
    expect(cfg.AF_VAULT_AUTH).toBe('kubernetes');
    expect(cfg.SCHEDULE_IDENTITIES).toEqual([
      { name: 'reports-team', clientId: '33333333-3333-4333-8333-333333333333' },
    ]);
  });

  it.each([
    [{ AF_VAULT_ADDR: 'http://vault.example.com' }, 'AF_VAULT_ADDR: must be https'],
    [{ AF_VAULT_ROLE: '' }, 'AF_VAULT_ROLE: required with AF_VAULT_AUTH=kubernetes'],
    [{ AF_VAULT_AUTH: 'approle' }, 'AF_VAULT_ROLE_ID and AF_VAULT_SECRET_ID_FILE: required'],
    [{ AF_VAULT_AUTH: 'token' }, 'AF_VAULT_TOKEN_FILE: required'],
    [
      { AF_AUTOMATION_CLIENT_SECRET: 'leftover-secret' },
      'AF_AUTOMATION_CLIENT_SECRET: must be empty with AF_VAULT_ADDR',
    ],
    [
      {
        AF_SCHEDULE_IDENTITIES: 'reports-team',
        AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
        AF_IDENTITY_REPORTS_TEAM_CERT_PATH: '/etc/adminforge/automation/reports.pem',
      },
      'AF_IDENTITY_REPORTS_TEAM_CERT_PATH: must be empty with AF_VAULT_ADDR',
    ],
  ])('refuses %o', (over, message) => {
    const run = () => loadConfig({ ...base, ...over });
    expect(run).toThrow(message);
    expect(run).not.toThrow(/leftover-secret/);
  });

  it('allows http to a loopback Vault outside production only, and never with mock sign-in', () => {
    const dev = { ...base, NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5173' };
    expect(loadConfig({ ...dev, AF_VAULT_ADDR: 'http://127.0.0.1:8200' }).AF_VAULT_ADDR).toBe(
      'http://127.0.0.1:8200',
    );
    expect(() => loadConfig({ ...base, AF_VAULT_ADDR: 'http://127.0.0.1:8200' })).toThrow('must be https');
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:5173',
        AUTH_MODE: 'mock',
        DATA_MODE: 'fixtures',
        AF_VAULT_ADDR: 'https://vault.example.com',
        AF_VAULT_ROLE: 'adminforge',
      }),
    ).toThrow('must not be set with AUTH_MODE=mock');
  });
});
