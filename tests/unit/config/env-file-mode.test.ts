import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvFileModeError, loadEnv } from '@adminforge/config';

// The env files hold the Read app's secret and the token-cache key, the admin file the provisioner's credentials. One
// other account on the machine that can read them holds the portal (S-19): loadEnv refuses a file with any group or
// world permission, naming the file and the fix — never what is in it. Only regular files are checked: /dev/null
// (mock mode and the container image) is nobody's file, and in Kubernetes the configuration arrives as environment
// variables, not through an env file.
const SECRET = 'synthetic-secret-value-in-the-file';

function configDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-env-mode-'));
  const file = (name: string, mode: number, lines = [`AF_READ_CLIENT_SECRET=${SECRET}`, 'A=1']) => {
    const f = path.join(dir, name);
    writeFileSync(f, `${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(f, mode);
    return f;
  };
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The error loadEnv throws (or undefined). */
function refusal(run: () => unknown): Error | undefined {
  try {
    run();
    return undefined;
  } catch (err) {
    return err as Error;
  }
}

describe.skipIf(process.platform === 'win32')('env files must be private (mode 600)', () => {
  it.each([
    ['600', 0o600],
    ['400', 0o400],
  ])('reads a file only its owner can read (mode %s)', (_label, mode) => {
    const c = configDir();
    try {
      const base = c.file('dev.env', mode);
      expect(loadEnv({ ADMINFORGE_ENV_FILE: base }).A).toBe('1');
    } finally {
      c.cleanup();
    }
  });

  it.each([
    ['644', 0o644],
    ['640', 0o640],
    ['604', 0o604],
    ['660', 0o660],
    ['620', 0o620],
    ['666', 0o666],
  ])('refuses mode %s, naming the file and the fix only', (label, mode) => {
    const c = configDir();
    try {
      const base = c.file('dev.env', mode);
      const err = refusal(() => loadEnv({ ADMINFORGE_ENV_FILE: base }));
      expect(err).toBeInstanceOf(EnvFileModeError);
      expect(err?.message).toContain(base);
      expect(err?.message).toContain(`chmod 600 ${base}`);
      expect(err?.message).toContain(`mode ${label}`);
      expect(err?.message).not.toContain(SECRET);
      expect(err?.message).not.toContain('AF_READ_CLIENT_SECRET');
    } finally {
      c.cleanup();
    }
  });

  it('checks the admin file only when it is read, and refuses it then', () => {
    const c = configDir();
    try {
      const base = c.file('dev.env', 0o600);
      const admin = c.file('dev.admin.env', 0o644, [`AF_PROVISIONER_CLIENT_SECRET=${SECRET}`]);
      // The services never read the admin file, so its mode doesn't stop them.
      expect(loadEnv({ ADMINFORGE_ENV_FILE: base }).A).toBe('1');
      const err = refusal(() => loadEnv({ ADMINFORGE_ENV_FILE: base }, { admin: true }));
      expect(err).toBeInstanceOf(EnvFileModeError);
      expect(err?.message).toContain(`chmod 600 ${admin}`);
      expect(err?.message).not.toContain(SECRET);
    } finally {
      c.cleanup();
    }
  });

  it('checks the overlay file too', () => {
    const c = configDir();
    try {
      const base = c.file('dev.env', 0o600);
      const host = c.file('dev.host.env', 0o640);
      const err = refusal(() => loadEnv({ ADMINFORGE_ENV_FILE: base, ADMINFORGE_ENV_OVERLAY: 'host' }));
      expect(err?.message).toContain(`chmod 600 ${host}`);
    } finally {
      c.cleanup();
    }
  });

  it('follows a symlink to the file it names', () => {
    const c = configDir();
    try {
      const real = c.file('real.env', 0o600);
      const link = path.join(c.dir, 'dev.env');
      symlinkSync(real, link);
      expect(loadEnv({ ADMINFORGE_ENV_FILE: link }).A).toBe('1');
      chmodSync(real, 0o644);
      expect(refusal(() => loadEnv({ ADMINFORGE_ENV_FILE: link }))).toBeInstanceOf(EnvFileModeError);
    } finally {
      c.cleanup();
    }
  });

  it('keeps ADMINFORGE_ENV_FILE=/dev/null working (mock mode, the container image: configuration from the environment)', () => {
    const env = { ADMINFORGE_ENV_FILE: '/dev/null', AF_TENANT_ID: 'from-the-environment' };
    expect(loadEnv(env)).toEqual(env);
    expect(loadEnv(env, { admin: true })).toEqual(env);
  });

  it('skips files that are not there', () => {
    const c = configDir();
    try {
      expect(loadEnv({ ADMINFORGE_ENV_FILE: path.join(c.dir, 'missing.env') }, { admin: true })).toEqual({
        ADMINFORGE_ENV_FILE: path.join(c.dir, 'missing.env'),
      });
    } finally {
      c.cleanup();
    }
  });
});
