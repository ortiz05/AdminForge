import { loadConfig } from '@adminforge/api/src/config';

// Production hardening — HSTS, the __Host- session cookie, the production checks (no mock sign-in, https, an absolute
// DATABASE_PATH, no admin credentials) and content from the database — keys off NODE_ENV, which defaults to
// development. The container image and the Kubernetes ConfigMap set production (tests/guards/image-node-env.test.ts);
// a portal other machines reach that lost it would quietly run without all of that. So Entra sign-in refuses to start
// beyond loopback outside production, while development against the tenant on this machine keeps working (S-01, D-04).
const entra: Record<string, string> = {
  PUBLIC_BASE_URL: 'http://localhost:5173',
  AUTH_MODE: 'entra',
  DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
  TOKEN_CACHE_KEY: Buffer.alloc(32, 3).toString('base64'),
  AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  AF_READ_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
  AF_READ_CLIENT_SECRET: 'synthetic-read-secret-value',
};

/** The configuration error's text ('' when it loads). */
const problem = (values: Record<string, string>): string => {
  try {
    loadConfig(values);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('Entra sign-in beyond this machine needs NODE_ENV=production', () => {
  describe.each([['(unset: development)'], ['development'], ['test']])('NODE_ENV %s', (nodeEnv) => {
    const base = nodeEnv.startsWith('(') ? entra : { ...entra, NODE_ENV: nodeEnv };

    it.each([undefined, '127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost'])(
      'development against the tenant on loopback keeps working (API_HOST=%s)',
      (host) => {
        for (const url of ['http://localhost:5173', 'https://localhost:5173', 'http://127.0.0.1:3001'])
          expect(problem({ ...base, PUBLIC_BASE_URL: url, ...(host ? { API_HOST: host } : {}) })).toBe('');
      },
    );

    it.each(['0.0.0.0', '::', '10.1.2.3', 'adminforge.example.com'])('refuses API_HOST=%s', (host) => {
      const message = problem({ ...base, API_HOST: host });
      expect(message).toMatch(/API_HOST: listens beyond this machine[^\n]*NODE_ENV=production/);
      expect(message).toContain('API_HOST=127.0.0.1');
    });

    it.each(['https://adminforge.example.com', 'https://10.1.2.3:8443', 'https://devbox:5173'])(
      'refuses PUBLIC_BASE_URL=%s (an https name other machines reach)',
      (url) => {
        const message = problem({ ...base, PUBLIC_BASE_URL: url });
        expect(message).toMatch(
          /PUBLIC_BASE_URL: is an https address other machines reach[^\n]*NODE_ENV=production/,
        );
        expect(message).toContain('http://localhost:<port>');
      },
    );
  });

  it('starts with the same settings in production (the pod: 0.0.0.0 behind the Ingress name)', () => {
    const prod = loadConfig({
      ...entra,
      NODE_ENV: 'production',
      API_HOST: '0.0.0.0',
      PUBLIC_BASE_URL: 'https://adminforge.example.com',
    });
    expect(prod).toMatchObject({ NODE_ENV: 'production', API_HOST: '0.0.0.0' });
  });

  it('names the keys only: never the values, never a secret', () => {
    const message = problem({
      ...entra,
      NODE_ENV: 'development',
      API_HOST: '10.9.8.7',
      PUBLIC_BASE_URL: 'https://adminforge.example.com',
    });
    expect(message).toMatch(/API_HOST:/);
    expect(message).toMatch(/PUBLIC_BASE_URL:/);
    expect(message).not.toContain('10.9.8.7');
    expect(message).not.toContain('adminforge.example.com');
    expect(message).not.toContain('synthetic-read-secret-value');
  });

  it('is the Entra rule only: mock sign-in has its own, stricter fence', () => {
    expect(
      problem({
        NODE_ENV: 'development',
        AUTH_MODE: 'mock',
        DATA_MODE: 'fixtures',
        API_HOST: '0.0.0.0',
        PUBLIC_BASE_URL: 'http://localhost:5173',
      }),
    ).toMatch(/API_HOST: mock sign-in only listens on loopback/);
  });
});
