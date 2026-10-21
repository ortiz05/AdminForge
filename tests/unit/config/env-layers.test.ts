import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  ADMIN_ENV_KEYS,
  adminEnvFilePath,
  envFilePath,
  envFiles,
  loadEnv,
  overlayEnvFilePath,
  parseEnv,
  updateEnvFile,
  writeEnvKeys,
} from '@adminforge/config';

// The provisioner-credential boundary: the services read the runtime file (and an overlay), never <env>.admin.env; the
// CLI asks for admin keys.

function configDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-config-'));
  const base = path.join(dir, 'dev.env');
  const write = (file: string, lines: string[]) =>
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return {
    dir,
    base,
    admin: path.join(dir, 'dev.admin.env'),
    host: path.join(dir, 'dev.host.env'),
    write,
    env: (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ADMINFORGE_ENV_FILE: base, ...extra }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const mode = (file: string) => statSync(file).mode & 0o777;

describe('env file locations', () => {
  it('uses ADMINFORGE_ENV_FILE, else ~/.config/adminforge/<ADMINFORGE_ENV or dev>.env', () => {
    expect(envFilePath({ ADMINFORGE_ENV_FILE: '/srv/af/prod.env' })).toBe('/srv/af/prod.env');
    expect(envFilePath({})).toBe(path.join(homedir(), '.config', 'adminforge', 'dev.env'));
    expect(envFilePath({ ADMINFORGE_ENV: 'prod' })).toBe(
      path.join(homedir(), '.config', 'adminforge', 'prod.env'),
    );
  });

  it('puts the admin file and overlays next to the env file', () => {
    const env = { ADMINFORGE_ENV_FILE: '/srv/af/dev.env', ADMINFORGE_ENV_OVERLAY: 'host' };
    expect(adminEnvFilePath(env)).toBe('/srv/af/dev.admin.env');
    expect(overlayEnvFilePath(env)).toBe('/srv/af/dev.host.env');
    expect(overlayEnvFilePath({ ADMINFORGE_ENV_FILE: '/srv/af/dev', ADMINFORGE_ENV_OVERLAY: 'host' })).toBe(
      '/srv/af/dev.host.env',
    );
    expect(overlayEnvFilePath({ ADMINFORGE_ENV_FILE: '/srv/af/dev.env' })).toBeUndefined();
  });

  it('accepts only lower-case letters, digits and dashes as an overlay name', () => {
    const file = '/srv/af/dev.env';
    for (const ok of ['host', 'host-2', 'a'.repeat(32)])
      expect(() =>
        overlayEnvFilePath({ ADMINFORGE_ENV_FILE: file, ADMINFORGE_ENV_OVERLAY: ok }),
      ).not.toThrow();
    for (const bad of ['Host', '../admin', 'admin/../x', 'host.env', 'a b', 'a'.repeat(33), 'host\n'])
      expect(() => overlayEnvFilePath({ ADMINFORGE_ENV_FILE: file, ADMINFORGE_ENV_OVERLAY: bad })).toThrow(
        /ADMINFORGE_ENV_OVERLAY/,
      );
    // loadEnv refuses too, before reading anything.
    expect(() => loadEnv({ ADMINFORGE_ENV_FILE: file, ADMINFORGE_ENV_OVERLAY: '../admin' })).toThrow(
      /ADMINFORGE_ENV_OVERLAY/,
    );
  });

  it('lists the layers lowest first, the admin file only when asked', () => {
    const env = { ADMINFORGE_ENV_FILE: '/srv/af/dev.env', ADMINFORGE_ENV_OVERLAY: 'host' };
    expect(envFiles(env)).toEqual(['/srv/af/dev.env', '/srv/af/dev.host.env']);
    expect(envFiles(env, { admin: true })).toEqual([
      '/srv/af/dev.env',
      '/srv/af/dev.admin.env',
      '/srv/af/dev.host.env',
    ]);
  });
});

describe('loadEnv layering', () => {
  it('base < admin < overlay < process.env', () => {
    const c = configDir();
    try {
      c.write(c.base, ['A=base', 'B=base', 'C=base', 'D=base']);
      c.write(c.admin, ['B=admin', 'C=admin', 'D=admin']);
      c.write(c.host, ['C=host', 'D=host']);
      const env = c.env({ ADMINFORGE_ENV_OVERLAY: 'host', D: 'process' });
      expect(loadEnv(env, { admin: true })).toMatchObject({ A: 'base', B: 'admin', C: 'host', D: 'process' });
      // Without `admin` the admin file is not read at all.
      expect(loadEnv(env)).toMatchObject({ A: 'base', B: 'base', C: 'host', D: 'process' });
    } finally {
      c.cleanup();
    }
  });

  it('skips missing files', () => {
    const c = configDir();
    try {
      expect(loadEnv(c.env({ X: '1' }), { admin: true })).toEqual({ ADMINFORGE_ENV_FILE: c.base, X: '1' });
    } finally {
      c.cleanup();
    }
  });

  it('keeps admin keys out unless asked, even when the base file still holds them (older layout)', () => {
    const c = configDir();
    try {
      c.write(c.base, [
        ...ADMIN_ENV_KEYS.map((k) => `${k}=from-base`),
        'AF_TENANT_ID=00000000-0000-0000-0000-000000000000',
      ]);
      c.write(c.host, ['AF_TEST_USER_PASSWORD=from-overlay']);
      const services = loadEnv(c.env({ ADMINFORGE_ENV_OVERLAY: 'host' }));
      for (const k of ADMIN_ENV_KEYS) expect(services).not.toHaveProperty(k);
      expect(services.AF_TENANT_ID).toBe('00000000-0000-0000-0000-000000000000');
      const cli = loadEnv(c.env({ ADMINFORGE_ENV_OVERLAY: 'host' }), { admin: true });
      expect(cli.AF_PROVISIONER_CLIENT_SECRET).toBe('from-base');
      expect(cli.AF_TEST_USER_PASSWORD).toBe('from-overlay');
    } finally {
      c.cleanup();
    }
  });
});

describe('parseEnv', () => {
  it('reads KEY=VALUE lines, strips matching quotes, skips comments and junk', () => {
    expect(
      parseEnv(
        [
          '# comment',
          '',
          'A=1',
          'B = "two words"',
          "C='x=y'",
          'D=',
          '  E=trimmed  ',
          'not a line',
          '1X=bad',
        ].join('\n'),
      ),
    ).toEqual({ A: '1', B: 'two words', C: 'x=y', D: '', E: 'trimmed' });
  });
});

describe('writing env files', () => {
  it('creates files 0600 in a 0700 directory, upserting keys and keeping comments and order', () => {
    const c = configDir();
    try {
      const file = path.join(c.dir, 'nested', 'dev.env');
      updateEnvFile({ A: '1' }, file);
      expect(mode(file)).toBe(0o600);
      expect(mode(path.dirname(file))).toBe(0o700);
      writeFileSync(file, '# keep me\nA=1\nB=2\n');
      chmodSync(file, 0o644);
      updateEnvFile({ B: '3', C: '4' }, file);
      expect(readFileSync(file, 'utf8')).toBe('# keep me\nA=1\nB=3\nC=4\n');
      // A file that was readable by others is tightened on the next write.
      expect(mode(file)).toBe(0o600);
    } finally {
      c.cleanup();
    }
  });

  it('routes admin keys to <env>.admin.env and the rest to the env file, both 0600', () => {
    const c = configDir();
    try {
      writeEnvKeys(
        {
          AF_PROVISIONER_CLIENT_ID: '11111111-1111-1111-1111-111111111111',
          AF_PROVISIONER_CLIENT_SECRET: 'example',
          AF_READ_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
        },
        c.env(),
      );
      expect(parseEnv(readFileSync(c.base, 'utf8'))).toEqual({
        AF_READ_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
      });
      expect(parseEnv(readFileSync(c.admin, 'utf8'))).toEqual({
        AF_PROVISIONER_CLIENT_ID: '11111111-1111-1111-1111-111111111111',
        AF_PROVISIONER_CLIENT_SECRET: 'example',
      });
      expect(mode(c.base)).toBe(0o600);
      expect(mode(c.admin)).toBe(0o600);
      // Only runtime keys: the admin file is not created.
      const d = configDir();
      try {
        writeEnvKeys({ AF_ENV_LABEL: 'dev' }, d.env());
        expect(existsSync(d.admin)).toBe(false);
      } finally {
        d.cleanup();
      }
    } finally {
      c.cleanup();
    }
  });
});
