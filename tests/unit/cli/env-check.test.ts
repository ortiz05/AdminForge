import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from '@adminforge/config';
import { checkEnv, formatEnvReport, PURPOSES, REQUIRED } from '@adminforge/cli/src/env-check';
import { repoRoot } from '../../lib/repo';

const EXAMPLE = `
# comment
PUBLIC_BASE_URL=http://localhost:5173
AUTH_MODE=entra
AF_TENANT_ID=
AF_PRIMARY_DOMAIN=
AF_SUBSCRIPTION_ID=
AF_ENV_LABEL=dev
AF_PROVISIONER_CLIENT_ID=
AF_PROVISIONER_CLIENT_SECRET=
AF_AUTOMATION_CLIENT_ID=
AF_AUTOMATION_CLIENT_SECRET=
AF_AUTOMATION_CERT_PATH=
TOKEN_CACHE_KEY=
`;
const TENANT = '0f1e2d3c-4b5a-4968-8776-655443322110';

describe('checkEnv', () => {
  it('classifies keys as set / default / missing / invalid', () => {
    const r = checkEnv(EXAMPLE, {
      AF_TENANT_ID: TENANT,
      AF_SUBSCRIPTION_ID: 'not-a-guid',
      TOKEN_CACHE_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    const state = Object.fromEntries(r.keys.map((k) => [k.key, k.state]));
    expect(state).toMatchObject({
      AF_TENANT_ID: 'set',
      PUBLIC_BASE_URL: 'default',
      AF_ENV_LABEL: 'default',
      AF_PRIMARY_DOMAIN: 'missing',
      AF_SUBSCRIPTION_ID: 'invalid',
      TOKEN_CACHE_KEY: 'set',
    });
    expect(r.keys.find((k) => k.key === 'AF_SUBSCRIPTION_ID')!.problem).toBe('expected a GUID');
  });

  it('reports readiness per purpose; alternatives (secret or certificate) satisfy a requirement', () => {
    const r = checkEnv(EXAMPLE, {
      AF_TENANT_ID: TENANT,
      AF_AUTOMATION_CLIENT_ID: TENANT,
      AF_AUTOMATION_CERT_PATH: '/x.pem',
    });
    expect(r.readiness.schedules).toEqual([]);
    expect(r.readiness.provision).toEqual([
      'AF_PRIMARY_DOMAIN',
      'AF_PROVISIONER_CLIENT_ID',
      'AF_PROVISIONER_CLIENT_SECRET',
    ]);
  });

  it('overlays process env and says so, and lists undocumented keys', () => {
    const r = checkEnv(EXAMPLE, { AF_TENANT_ID: 'bad', AF_TYPO_KEY: 'x' }, { AF_TENANT_ID: TENANT });
    expect(r.keys.find((k) => k.key === 'AF_TENANT_ID')).toMatchObject({ state: 'set', source: 'process' });
    expect(r.unknown).toEqual(['AF_TYPO_KEY']);
  });

  it('never prints values, only key names and states', () => {
    const secret = 'S3cr3t-Value-Never-Printed';
    const r = checkEnv(EXAMPLE, {
      AF_TENANT_ID: TENANT,
      AF_PROVISIONER_CLIENT_SECRET: secret,
      AF_PRIMARY_DOMAIN: 'example.com',
    });
    const { lines, ok } = formatEnvReport(r, '/home/x/.config/adminforge/dev.env', ['provision']);
    const text = lines.join('\n');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain('example.com');
    expect(text).toMatch(/AF_PROVISIONER_CLIENT_SECRET\s+set/);
    expect(ok).toBe(false); // provisioner client id missing
  });

  it('every key a purpose requires is documented in config/example.env', () => {
    const example = parseEnv(readFileSync(path.join(repoRoot, 'config', 'example.env'), 'utf8'));
    const required = PURPOSES.flatMap((p) => REQUIRED[p].flatMap((k) => k.split('|')));
    expect(required.filter((k) => !(k in example))).toEqual([]);
  });
});
