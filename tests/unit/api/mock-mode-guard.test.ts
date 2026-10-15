import { isLoopbackHost, loadConfig } from '@adminforge/api/src/config';
import { createContext } from '@adminforge/api/src/context';

// Mock sign-in gives every visitor every portal role without a password: only on this machine, on synthetic data, and
// never next to credentials that reach the tenant (Read/Write apps, automation identity, runner).
const mock = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  AUTH_MODE: 'mock',
  DATA_MODE: 'fixtures',
};

describe('AUTH_MODE=mock guard', () => {
  it('accepts fixtures on loopback with no credentials', () => {
    expect(loadConfig(mock).API_HOST).toBe('127.0.0.1');
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost'])
      expect(loadConfig({ ...mock, API_HOST: host }).AUTH_MODE).toBe('mock');
  });

  it('refuses live data', () =>
    expect(() => loadConfig({ ...mock, DATA_MODE: 'live' })).toThrow(
      /mock sign-in needs DATA_MODE=fixtures/,
    ));

  it('refuses the default data mode (live) too', () => {
    const { DATA_MODE: _d, ...noData } = mock;
    expect(() => loadConfig(noData)).toThrow(/DATA_MODE=fixtures/);
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', 'adminforge.example.com'])('refuses API_HOST=%s', (host) =>
    expect(() => loadConfig({ ...mock, API_HOST: host })).toThrow(
      /API_HOST: mock sign-in only listens on loopback/,
    ),
  );

  it.each([
    'AF_READ_CLIENT_SECRET',
    'AF_WRITE_CLIENT_SECRET',
    'AF_AUTOMATION_CLIENT_SECRET',
    'AF_AUTOMATION_CERT_PATH',
    'RUNNER_SHARED_KEY',
  ])('refuses to start with %s set (and never echoes its value)', (key) => {
    const value = key === 'RUNNER_SHARED_KEY' ? 'r'.repeat(48) : 'synthetic-secret-value';
    const extra: Record<string, string> =
      key === 'AF_WRITE_CLIENT_SECRET'
        ? { AF_WRITE_CLIENT_ID: '33333333-4444-4555-8666-777777777777' }
        : key.startsWith('AF_AUTOMATION')
          ? { AF_AUTOMATION_CLIENT_ID: '55555555-6666-4777-8888-999999999999' }
          : {};
    let message = '';
    try {
      loadConfig({ ...mock, ...extra, [key]: value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`${key}: must not be set with AUTH_MODE=mock`);
    expect(message).not.toContain(value);
  });

  it('empty credential keys (an env file template) are fine', () =>
    expect(loadConfig({ ...mock, AF_READ_CLIENT_SECRET: '', RUNNER_SHARED_KEY: '  ' }).AUTH_MODE).toBe(
      'mock',
    ));

  it('never builds the automation identity in mock mode', () => {
    const ctx = createContext(loadConfig(mock), { database: null });
    expect(ctx.auth).toBeNull();
    expect(ctx.automation).toBeNull();
  });

  it('isLoopbackHost', () => {
    expect(isLoopbackHost('127.10.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
  });
});

describe('AF_CONNECTION_AUDIENCE_HOSTS and OUTBOUND_MAX_BYTES', () => {
  it('takes host names', () =>
    expect(
      loadConfig({ ...mock, AF_CONNECTION_AUDIENCE_HOSTS: 'api.example.com, hr.example.org' }),
    ).toMatchObject({
      AF_CONNECTION_AUDIENCE_HOSTS: 'api.example.com, hr.example.org',
      OUTBOUND_MAX_BYTES: 64 * 1024 * 1024,
    }));
  it('refuses URLs', () =>
    expect(() => loadConfig({ ...mock, AF_CONNECTION_AUDIENCE_HOSTS: 'https://api.example.com' })).toThrow(
      /AF_CONNECTION_AUDIENCE_HOSTS/,
    ));
  it('bounds OUTBOUND_MAX_BYTES', () =>
    expect(() => loadConfig({ ...mock, OUTBOUND_MAX_BYTES: '10' })).toThrow(/OUTBOUND_MAX_BYTES/));
});
