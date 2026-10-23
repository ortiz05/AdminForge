import { loadConfig } from '@adminforge/api/src/config';

// The accounts read-only schedules run as when they name none (AF_SCHEDULE_DEFAULT_IDENTITY, …_REPORTS, …_PROBES):
// `automation` or a configured app identity. Anything else stops start-up, naming the key only.
const base = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://adminforge.example.com',
  TOKEN_CACHE_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
  AUTH_MODE: 'entra',
  AF_TENANT_ID: '00000000-0000-4000-8000-000000000000',
  AF_READ_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
  AF_READ_CLIENT_SECRET: 'synthetic-read-secret',
  AF_SCHEDULE_IDENTITIES: 'reports-team',
  AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  AF_IDENTITY_REPORTS_TEAM_CLIENT_SECRET: 'synthetic-identity-secret',
};

describe('default run-as accounts', () => {
  it('has none unless set', () => {
    expect(loadConfig(base).SCHEDULE_DEFAULTS).toEqual({});
  });

  it('reads each key as automation or a configured app identity', () => {
    const cfg = loadConfig({
      ...base,
      AF_SCHEDULE_DEFAULT_IDENTITY: 'automation',
      AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS: 'reports-team',
    });
    expect(cfg.SCHEDULE_DEFAULTS).toEqual({ all: 'automation', reports: 'reports-team' });
  });

  it('refuses a name that is not a configured identity, naming the key and not the value', () => {
    const run = () => loadConfig({ ...base, AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS: 'probe-squad-x' });
    expect(run).toThrow(
      /AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS: must be automation or a name listed in AF_SCHEDULE_IDENTITIES/,
    );
    expect(run).not.toThrow(/probe-squad-x/);
  });
});
