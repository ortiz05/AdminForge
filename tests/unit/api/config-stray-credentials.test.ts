import { loadConfig } from '@adminforge/api/src/config';

// In the pod the configuration is a Secret made from an env file (portal/deploy/kubernetes/README.md → Secrets). A
// whole file copied in would bring credentials the portal must never hold — the provisioner's and test accounts'
// (admin-only), and the Postgres releases' database passwords. Production refuses to start, naming the keys only.
const production = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://adminforge.example.com',
  AUTH_MODE: 'entra',
  AF_TENANT_ID: '00000000-0000-4000-8000-000000000000',
  AF_READ_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
  AF_READ_CLIENT_SECRET: 'synthetic-read-secret',
  TOKEN_CACHE_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
};

describe('credentials that must not reach the running portal', () => {
  it('starts without them', () => {
    expect(loadConfig(production).NODE_ENV).toBe('production');
  });

  it('refuses admin-only keys and the old database URLs in production, by name only', () => {
    const run = () =>
      loadConfig({
        ...production,
        AF_PROVISIONER_CLIENT_SECRET: 'provisioner-secret-value',
        AF_TEST_USER_PASSWORD: 'test-password-value',
        DATABASE_URL: 'postgres://adminforge_app:db-password-value@127.0.0.1:55432/adminforge',
      });
    expect(run).toThrow(/AF_PROVISIONER_CLIENT_SECRET: must not be set where the portal runs/);
    expect(run).toThrow(/AF_TEST_USER_PASSWORD: must not be set/);
    expect(run).toThrow(/DATABASE_URL: no longer used \(ADR-016\) and holds a database password/);
    try {
      run();
    } catch (err) {
      expect(String(err)).not.toMatch(/secret-value|password-value/);
    }
  });

  it('leaves development alone (the CLI and a developer API read the same files)', () => {
    // On this machine: an https name others reach needs production (config-node-env-off-loopback.test.ts).
    expect(() =>
      loadConfig({
        ...production,
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'http://localhost:5173',
        DATABASE_URL: 'postgres://x@127.0.0.1/x',
      }),
    ).not.toThrow();
  });
});
