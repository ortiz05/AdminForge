import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { envFilePath, ownerEnvFilePaths, parseEnv, updateEnvFile } from '@adminforge/config';

/**
 * Prepares the local env file for this host: adds ONLY keys that are missing, empty, or still hold the
 * `CHANGE_ME` placeholder from config/example.env (so `cp config/example.env …` then `init:local` works).
 * Real values are never changed and no value is ever printed.
 *
 *   pnpm --filter @adminforge/api init:local   # then pnpm db:up, pnpm db:harden, pnpm --filter @adminforge/api db:migrate
 *
 * - The env file gets DATABASE_URL for the development database's own non-superuser owner (adminforge_dev on
 *   adminforge_dev — names from portal/deploy/defaults.env, kept in step by tests/unit/deploy/deploy-defaults.test.ts);
 *   `pnpm db:harden` creates that role with this password.
 * - The owner file (<env>.owner.env, which the services never read) gets POSTGRES_PASSWORD, the container's bootstrap
 *   superuser — only used when `pnpm db:up` creates a new cluster. An older env file that still holds it keeps it
 *   (`pnpm db:harden` moves it).
 */
export const DEV_DATABASE = {
  user: 'adminforge_dev',
  database: 'adminforge_dev',
  host: '127.0.0.1',
  port: '55432',
};

export function localKeys(
  current: Record<string, string>,
  owner: Record<string, string> = {},
): { env: Record<string, string>; owner: Record<string, string> } {
  const real = (v: string | undefined) => Boolean(v?.trim()) && !v!.includes('CHANGE_ME');
  const env: Record<string, string> = {};
  const ownerAdd: Record<string, string> = {};

  if (!real(current.DATABASE_URL)) {
    const pw = randomBytes(24).toString('base64url');
    const { user, database, host, port } = DEV_DATABASE;
    env.DATABASE_URL = `postgres://${user}:${encodeURIComponent(pw)}@${host}:${port}/${database}`;
  }
  if (!real(current.POSTGRES_PASSWORD) && !real(owner.POSTGRES_PASSWORD))
    ownerAdd.POSTGRES_PASSWORD = randomBytes(24).toString('base64url');
  if (!real(current.TOKEN_CACHE_KEY)) env.TOKEN_CACHE_KEY = randomBytes(32).toString('base64');

  const defaults: Record<string, string> = {
    PUBLIC_BASE_URL: 'http://localhost:5173',
    API_PORT: '3001',
    AUTH_MODE: 'entra',
    DATA_MODE: 'live',
    AF_ENV_LABEL: 'dev',
  };
  for (const [k, v] of Object.entries(defaults)) if (!real(current[k])) env[k] = v;
  return { env, owner: ownerAdd };
}

/** The env-file part of `localKeys` (kept for callers that only need it). */
export const missingLocalKeys = (current: Record<string, string>) => localKeys(current).env;

function main() {
  const file = envFilePath();
  const ownerFile = ownerEnvFilePaths()[0]!;
  const read = (f: string) => (existsSync(f) ? parseEnv(readFileSync(f, 'utf8')) : {});
  const add = localKeys(read(file), read(ownerFile));
  const keys = Object.keys(add.env);
  const ownerKeys = Object.keys(add.owner);
  if (!keys.length && !ownerKeys.length) {
    console.log(`${file}: nothing to add.`);
    return;
  }
  if (keys.length) {
    updateEnvFile(add.env, file);
    console.log(`${file}: added ${keys.join(', ')} (values not shown).`);
  }
  if (ownerKeys.length) {
    updateEnvFile(add.owner, ownerFile);
    console.log(`${ownerFile}: added ${ownerKeys.join(', ')} (values not shown).`);
  }
}

if (process.argv[1] && /init-local\.[cm]?[jt]s$/.test(process.argv[1])) main();
