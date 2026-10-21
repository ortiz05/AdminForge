import { loadConfig } from '@adminforge/api/src/config';

// Mock sign-in hands every visitor every portal role without a password. A loopback API_HOST alone doesn't keep it on
// this machine: a reverse proxy or tunnel on the same machine can publish it under another name, and PUBLIC_BASE_URL is
// that name. So the fence also requires a loopback PUBLIC_BASE_URL host (S-16).
const mock = { NODE_ENV: 'test', AUTH_MODE: 'mock', DATA_MODE: 'fixtures' };

const problem = (values: Record<string, string>): string => {
  try {
    loadConfig(values);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('AUTH_MODE=mock: PUBLIC_BASE_URL', () => {
  it.each([
    'http://localhost:5173',
    'http://localhost:4174/',
    'http://127.0.0.1:5173',
    'http://[::1]:5173',
    'https://localhost:5173',
  ])('accepts %s', (url) => {
    expect(problem({ ...mock, PUBLIC_BASE_URL: url })).toBe('');
  });

  it.each([
    'http://192.168.1.20:5173',
    'https://adminforge.example.com',
    'http://devbox:5173',
    'http://localhost.example.com:5173',
    'http://0.0.0.0:5173',
  ])('refuses %s, even with a loopback API_HOST', (url) => {
    const message = problem({ ...mock, API_HOST: '127.0.0.1', PUBLIC_BASE_URL: url });
    expect(message).toMatch(/PUBLIC_BASE_URL: mock sign-in only serves this machine/);
    expect(message).toContain('http://localhost:<port>');
    // Keys only, never the value.
    expect(message).not.toContain(new URL(url).hostname.replace(/^\[|\]$/g, ''));
  });

  it('reports both fences together when the API also listens beyond loopback', () => {
    const message = problem({
      ...mock,
      API_HOST: '0.0.0.0',
      PUBLIC_BASE_URL: 'https://adminforge.example.com',
    });
    expect(message).toMatch(/API_HOST: mock sign-in only listens on loopback/);
    expect(message).toMatch(/PUBLIC_BASE_URL: mock sign-in only serves this machine/);
  });
});
