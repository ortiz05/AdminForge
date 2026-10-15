import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { envFilePath, parseEnv, updateEnvFile } from '@adminforge/config';

/**
 * Prepares the local env file for this host: adds ONLY keys that are missing (or empty).
 * Existing values are never changed and no value is ever printed.
 *
 *   pnpm --filter @adminforge/api init:local
 */
export function missingLocalKeys(current: Record<string, string>): Record<string, string> {
  const has = (k: string) => Boolean(current[k]?.trim());
  const add: Record<string, string> = {};

  // Postgres password and DATABASE_URL must agree. Reuse whichever exists.
  let password = current.POSTGRES_PASSWORD?.trim();
  if (!password && has('DATABASE_URL')) {
    try {
      const url = new URL(current.DATABASE_URL!);
      if (url.hostname === '127.0.0.1' && url.port === '55432' && url.password) password = decodeURIComponent(url.password);
    } catch {
      // Not a URL we manage; leave it alone and generate a fresh password for the container.
    }
  }
  if (!password) password = randomBytes(24).toString('base64url');
  if (!has('POSTGRES_PASSWORD')) add.POSTGRES_PASSWORD = password;
  if (!has('DATABASE_URL')) add.DATABASE_URL = `postgres://adminforge:${encodeURIComponent(password)}@127.0.0.1:55432/adminforge`;
  if (!has('TOKEN_CACHE_KEY')) add.TOKEN_CACHE_KEY = randomBytes(32).toString('base64');

  const defaults: Record<string, string> = {
    PUBLIC_BASE_URL: 'http://localhost:5173',
    API_PORT: '3001',
    AUTH_MODE: 'entra',
    DATA_MODE: 'live',
    AF_ENV_LABEL: 'dev',
  };
  for (const [k, v] of Object.entries(defaults)) if (!has(k)) add[k] = v;
  return add;
}

function main() {
  const file = envFilePath();
  const current = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const add = missingLocalKeys(current);
  const keys = Object.keys(add);
  if (keys.length === 0) {
    console.log(`${file}: nothing to add.`);
    return;
  }
  updateEnvFile(add, file);
  console.log(`${file}: added ${keys.join(', ')} (values not shown).`);
}

if (process.argv[1] && /init-local\.[cm]?[jt]s$/.test(process.argv[1])) main();
