import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envFiles, loadEnv, ownerEnvFilePaths, removeEnvKeys, writeEnvKeys } from '@adminforge/config';

// The database owner's credentials live in owner files (<env>.owner.env, <env>.<overlay>.owner.env) that only
// migrations and the database scripts read (`owner: true`); the services, the CLI and `pnpm dev` never do.
function dir() {
  const d = mkdtempSync(path.join(tmpdir(), 'af-owner-'));
  return {
    d,
    p: (f: string) => path.join(d, f),
    write: (f: string, lines: string[]) =>
      writeFileSync(path.join(d, f), `${lines.join('\n')}\n`, { mode: 0o600 }),
    cleanup: () => rmSync(d, { recursive: true, force: true }),
  };
}

describe('owner env files', () => {
  it('sit next to the env file and its overlay, read only with owner: true', () => {
    const env = { ADMINFORGE_ENV_FILE: '/srv/af/dev.env', ADMINFORGE_ENV_OVERLAY: 'host' };
    expect(ownerEnvFilePaths(env)).toEqual(['/srv/af/dev.owner.env', '/srv/af/dev.host.owner.env']);
    expect(ownerEnvFilePaths({ ADMINFORGE_ENV_FILE: '/srv/af/dev.env' })).toEqual(['/srv/af/dev.owner.env']);
    expect(envFiles(env)).toEqual(['/srv/af/dev.env', '/srv/af/dev.host.env']);
    expect(envFiles(env, { owner: true })).toEqual([
      '/srv/af/dev.env',
      '/srv/af/dev.owner.env',
      '/srv/af/dev.host.env',
      '/srv/af/dev.host.owner.env',
    ]);
  });

  it('give migrations the overlay owner URL and keep it from everyone else', () => {
    const c = dir();
    try {
      c.write('dev.env', ['DATABASE_URL=postgres://adminforge_dev:d@127.0.0.1:55432/adminforge_dev']);
      c.write('dev.owner.env', ['POSTGRES_PASSWORD=example-superuser']);
      c.write('dev.host.env', ['DATABASE_URL=postgres://adminforge_app:a@127.0.0.1:55432/adminforge']);
      c.write('dev.host.owner.env', [
        'DATABASE_MIGRATION_URL=postgres://adminforge_owner:o@127.0.0.1:55432/adminforge',
      ]);
      const env = { ADMINFORGE_ENV_FILE: c.p('dev.env'), ADMINFORGE_ENV_OVERLAY: 'host' };
      const services = loadEnv(env);
      expect(services.DATABASE_URL).toMatch(/adminforge_app/);
      expect(services).not.toHaveProperty('DATABASE_MIGRATION_URL');
      expect(services).not.toHaveProperty('POSTGRES_PASSWORD');
      expect(loadEnv(env, { admin: true })).not.toHaveProperty('DATABASE_MIGRATION_URL');
      expect(loadEnv(env, { owner: true })).toMatchObject({
        DATABASE_URL: expect.stringMatching(/adminforge_app/),
        DATABASE_MIGRATION_URL: expect.stringMatching(/adminforge_owner/),
        POSTGRES_PASSWORD: 'example-superuser',
      });
    } finally {
      c.cleanup();
    }
  });

  it('writeEnvKeys routes owner keys to the owner file, removeEnvKeys drops keys and keeps the rest', () => {
    const c = dir();
    try {
      c.write('dev.env', ['# note', 'POSTGRES_PASSWORD=old', 'AF_ENV_LABEL=dev']);
      const env = { ADMINFORGE_ENV_FILE: c.p('dev.env') };
      writeEnvKeys({ POSTGRES_PASSWORD: 'new', AF_ENV_LABEL: 'dev' }, env);
      expect(readFileSync(c.p('dev.owner.env'), 'utf8')).toBe('POSTGRES_PASSWORD=new\n');
      expect(statSync(c.p('dev.owner.env')).mode & 0o777).toBe(0o600);
      removeEnvKeys(['POSTGRES_PASSWORD'], c.p('dev.env'));
      expect(readFileSync(c.p('dev.env'), 'utf8')).toBe('# note\nAF_ENV_LABEL=dev\n');
      removeEnvKeys(['X'], c.p('missing.env'));
      // With an overlay, the superuser password still goes to the base owner file (compose reads it from there); the
      // migration URL goes to the overlay's.
      const host = { ...env, ADMINFORGE_ENV_OVERLAY: 'host' };
      writeEnvKeys(
        { POSTGRES_PASSWORD: 'newer', DATABASE_MIGRATION_URL: 'postgres://o:p@h/adminforge' },
        host,
      );
      expect(readFileSync(c.p('dev.owner.env'), 'utf8')).toBe('POSTGRES_PASSWORD=newer\n');
      expect(readFileSync(c.p('dev.host.owner.env'), 'utf8')).toBe(
        'DATABASE_MIGRATION_URL=postgres://o:p@h/adminforge\n',
      );
    } finally {
      c.cleanup();
    }
  });
});
