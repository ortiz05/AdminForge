import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '@adminforge/api/src/config';
import {
  contentEnv,
  contentEnvKeys,
  declaredEnvKeys,
  hiddenFromContent,
} from '@adminforge/api/src/datasources/env';
import { repoRoot } from '../../lib/repo';

// S-29: the `env` scope of content expressions is an allow-list built from config/example.env's keys — the same keys
// `adminforge validate` accepts at publish time — not a denylist over the whole process environment (in the pod, the
// Secret plus the ConfigMap). A setting the example doesn't declare never reaches content, whatever its name.
const TEST = { NODE_ENV: 'test' } as Config;
const exampleText = readFileSync(path.join(repoRoot, 'config', 'example.env'), 'utf8');

describe('content env allow-list', () => {
  it('passes declared, non-secret AF_ settings', () => {
    expect(
      contentEnv(TEST, { AF_MAIL_DOMAIN: 'example.com', AF_REPORT_RECIPIENTS: 'ops@example.com' }),
    ).toEqual({ AF_MAIL_DOMAIN: 'example.com', AF_REPORT_RECIPIENTS: 'ops@example.com' });
  });

  it('drops settings config/example.env does not declare, even with harmless-looking names', () => {
    const env = contentEnv(TEST, {
      AF_MAIL_DOMAIN: 'example.com',
      // Names the old denylist let through: not declared, so never content's.
      AF_SESSION_SIGNING_SALT: 'synthetic-salt',
      AF_INTERNAL_ADMIN_UPN: 'admin@example.com',
      AF_IDENTITY_FINANCE_CLIENT_ID: '00000000-0000-4000-8000-000000000001',
      AF_ENV_LABEL_TYPO: 'x',
    });
    expect(Object.keys(env)).toEqual(['AF_MAIL_DOMAIN']);
  });

  it('still drops declared settings whose names look like secrets, and everything outside AF_', () => {
    const env = contentEnv(TEST, {
      AF_READ_CLIENT_SECRET: 'synthetic-secret',
      AF_AUTOMATION_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
      PUBLIC_BASE_URL: 'https://adminforge.example.com',
      DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
      RUNNER_SHARED_KEY: 'synthetic-key',
    });
    expect(env).toEqual({ AF_AUTOMATION_CLIENT_ID: '00000000-0000-4000-8000-000000000002' });
  });

  it('builds the list the way validate reads the example (declared, AF_, not secret-looking)', () => {
    const declared = declaredEnvKeys(exampleText);
    expect(declared.length).toBeGreaterThan(20);
    expect([...contentEnvKeys()].sort()).toEqual(
      declared.filter((k) => k.startsWith('AF_') && !hiddenFromContent(k)).sort(),
    );
    // Commented-out keys and prose are not declarations.
    expect(declaredEnvKeys('# AF_COMMENTED=1\nAF_REAL=\n  AF_INDENTED=2\nnot a key\n')).toEqual(['AF_REAL']);
  });

  it('keeps every AF_ setting shipped content reads', () => {
    const allowed = contentEnvKeys();
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (/\.ya?ml$/.test(name))
          for (const m of readFileSync(file, 'utf8').matchAll(/\benv\.(AF_[A-Z0-9_]+)/g)) used.add(m[1]!);
      }
    };
    walk(path.join(repoRoot, 'portal', 'content'));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((k) => !allowed.has(k))).toEqual([]);
  });

  it('fails loudly when config/example.env is missing, instead of passing everything or nothing silently', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-env-allowlist-'));
    expect(() => contentEnvKeys(path.join(dir, 'example.env'))).toThrow(/example\.env/);
    const file = path.join(dir, 'example.env');
    writeFileSync(file, '# Synthetic\nAF_ONLY_THIS=\nAF_OTHER_SECRET=\n');
    expect([...contentEnvKeys(file)]).toEqual(['AF_ONLY_THIS']);
    expect(contentEnv(TEST, { AF_ONLY_THIS: 'a', AF_MAIL_DOMAIN: 'b' }, contentEnvKeys(file))).toEqual({
      AF_ONLY_THIS: 'a',
    });
  });
});
