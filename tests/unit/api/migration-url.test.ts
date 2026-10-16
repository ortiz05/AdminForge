import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnv } from '@adminforge/config';
import { migrationUrl } from '@adminforge/api/src/db/migrate';

// `ADMINFORGE_ENV_OVERLAY=host pnpm --filter @adminforge/api db:migrate` migrates the services' database as the owner
// (DATABASE_MIGRATION_URL from <env>.host.env), while the services reading the same files never see that URL.
const OWNER_URL = 'postgres://adminforge:example-owner-password@127.0.0.1:55432/adminforge';
const APP_URL = 'postgres://adminforge_app:example-app-password@127.0.0.1:55432/adminforge';
const DEV_URL = 'postgres://adminforge:example-owner-password@127.0.0.1:55432/adminforge_dev';

describe('db:migrate connection', () => {
  let dir: string;
  let base: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-migrate-'));
    base = path.join(dir, 'dev.env');
    writeFileSync(base, `DATABASE_URL=${DEV_URL}\nPOSTGRES_PASSWORD=example-owner-password\n`);
    writeFileSync(
      path.join(dir, 'dev.host.env'),
      `DATABASE_URL=${APP_URL}\nDATABASE_MIGRATION_URL=${OWNER_URL}\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('uses the owner URL from the host overlay; the services get only the app role', () => {
    const env = { ADMINFORGE_ENV_FILE: base, ADMINFORGE_ENV_OVERLAY: 'host' };
    expect(migrationUrl(env)).toBe(OWNER_URL);
    const services = loadEnv(env);
    expect(services.DATABASE_URL).toBe(APP_URL);
    expect(services.DATABASE_MIGRATION_URL).toBeUndefined();
  });

  it('falls back to DATABASE_URL without an owner URL (the dev database)', () => {
    expect(migrationUrl({ ADMINFORGE_ENV_FILE: base })).toBe(DEV_URL);
  });

  it('is undefined when nothing is configured', () => {
    expect(migrationUrl({ ADMINFORGE_ENV_FILE: path.join(dir, 'missing.env') })).toBeUndefined();
  });
});
