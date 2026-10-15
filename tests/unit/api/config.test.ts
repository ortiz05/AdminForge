import path from 'node:path';
import { loadConfig } from '@adminforge/api/src/config';
import { PORTAL_ROLES } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

const base = { NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://localhost:5173' };
const entra = {
  ...base,
  AUTH_MODE: 'entra',
  DATABASE_URL: 'postgres://x@127.0.0.1:55432/x',
  TOKEN_CACHE_KEY: Buffer.alloc(32, 1).toString('base64'),
  AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  AF_READ_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
  AF_READ_CLIENT_SECRET: 'super-secret-value-123',
};

describe('loadConfig', () => {
  it('requires tenant and Read app settings when AUTH_MODE=entra', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'entra' })).toThrow(/AF_TENANT_ID[\s\S]*AF_READ_CLIENT_ID[\s\S]*AF_READ_CLIENT_SECRET[\s\S]*TOKEN_CACHE_KEY[\s\S]*DATABASE_URL/);
    expect(loadConfig(entra).AUTH_MODE).toBe('entra');
  });

  it('defaults to Entra auth and live data', () => {
    const cfg = loadConfig(entra);
    expect(cfg).toMatchObject({ AUTH_MODE: 'entra', DATA_MODE: 'live', API_PORT: 3001, API_HOST: '127.0.0.1', SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 12, WRITE_SESSION_MAX_MINUTES: 60 });
  });

  it('refuses mock auth in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'mock', DATABASE_URL: 'postgres://x' })).toThrow(/mock auth is not allowed in production/);
  });

  it('requires https in production', () => {
    expect(() => loadConfig({ ...entra, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://adminforge.example.com' })).toThrow(/PUBLIC_BASE_URL: must be https/);
    const prod = loadConfig({ ...entra, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://adminforge.example.com/' });
    expect(prod.PUBLIC_BASE_URL).toBe('https://adminforge.example.com');
    expect(prod.API_HOST).toBe('0.0.0.0');
  });

  it('never echoes values (secrets) in errors', () => {
    let message = '';
    try {
      loadConfig({ ...entra, AF_TENANT_ID: 'not-a-guid', TOKEN_CACHE_KEY: 'c2hvcnQ=' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/AF_TENANT_ID/);
    expect(message).toMatch(/TOKEN_CACHE_KEY must be 32 random bytes/);
    expect(message).not.toContain('not-a-guid');
    expect(message).not.toContain('c2hvcnQ=');
    expect(message).not.toContain('super-secret-value-123');
  });

  it('treats empty values as unset and defaults the fixtures dir to <repoRoot>/tests/fixtures', () => {
    const cfg = loadConfig({ ...base, AUTH_MODE: 'mock', ADMINFORGE_FIXTURES_DIR: '', WRITE_AUTH_CONTEXT: '', AF_TENANT_ID: '' });
    expect(cfg.ADMINFORGE_FIXTURES_DIR).toBe(path.join(repoRoot, 'tests', 'fixtures'));
    expect(cfg.WEB_DIST_DIR).toBe(path.join(repoRoot, 'portal', 'apps', 'web', 'dist'));
    expect(cfg.WRITE_AUTH_CONTEXT).toBeUndefined();
  });

  it('MOCK_ROLES defaults to every portal role and validates names', () => {
    expect(loadConfig({ ...base, AUTH_MODE: 'mock' }).MOCK_ROLES).toEqual([...PORTAL_ROLES]);
    expect(loadConfig({ ...base, AUTH_MODE: 'mock', MOCK_ROLES: 'Portal.Reader, Portal.Admin' }).MOCK_ROLES).toEqual(['Portal.Reader', 'Portal.Admin']);
    expect(() => loadConfig({ ...base, AUTH_MODE: 'mock', MOCK_ROLES: 'Portal.Reader,Root' })).toThrow(/MOCK_ROLES/);
  });

  it('validates WRITE_AUTH_CONTEXT, write-app pairs, and the write window', () => {
    expect(loadConfig({ ...entra, WRITE_AUTH_CONTEXT: 'c1' }).WRITE_AUTH_CONTEXT).toBe('c1');
    expect(() => loadConfig({ ...entra, WRITE_AUTH_CONTEXT: 'c0' })).toThrow(/WRITE_AUTH_CONTEXT/);
    expect(() => loadConfig({ ...entra, AF_WRITE_CLIENT_ID: '33333333-4444-4555-8666-777777777777' })).toThrow(/set together/);
    expect(() => loadConfig({ ...entra, WRITE_SESSION_MAX_MINUTES: '600' })).toThrow(/WRITE_SESSION_MAX_MINUTES/);
  });
});
