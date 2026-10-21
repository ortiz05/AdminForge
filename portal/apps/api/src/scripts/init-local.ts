import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { envFilePath, parseEnv, updateEnvFile } from '@adminforge/config';

/**
 * Prepares the local env file for this machine: adds ONLY keys that are missing, empty, or still hold the
 * `CHANGE_ME` placeholder from config/example.env (so `cp config/example.env …` then `init:local` works).
 * Real values are never changed and no value is ever printed.
 *
 *   pnpm --filter @adminforge/api init:local   # then pnpm dev (the API creates and migrates the database file)
 *
 * The env file gets DATABASE_PATH for a development database of its own (a SQLite file under
 * ~/.local/share/adminforge, ADR-016) — never the file of a deployment.
 */
export const DEV_DATABASE_PATH = '~/.local/share/adminforge/dev.db';

export function localKeys(current: Record<string, string>): { env: Record<string, string> } {
  const real = (v: string | undefined) => Boolean(v?.trim()) && !v!.includes('CHANGE_ME');
  const env: Record<string, string> = {};

  if (!real(current.DATABASE_PATH)) env.DATABASE_PATH = DEV_DATABASE_PATH;
  if (!real(current.TOKEN_CACHE_KEY)) env.TOKEN_CACHE_KEY = randomBytes(32).toString('base64');

  const defaults: Record<string, string> = {
    PUBLIC_BASE_URL: 'http://localhost:5173',
    API_PORT: '3001',
    AUTH_MODE: 'entra',
    DATA_MODE: 'live',
    AF_ENV_LABEL: 'dev',
  };
  for (const [k, v] of Object.entries(defaults)) if (!real(current[k])) env[k] = v;
  return { env };
}

/** The env-file part of `localKeys` (kept for callers that only need it). */
export const missingLocalKeys = (current: Record<string, string>) => localKeys(current).env;

function main() {
  const file = envFilePath();
  const current = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const add = localKeys(current).env;
  const keys = Object.keys(add);
  if (!keys.length) {
    console.log(`${file}: nothing to add.`);
    return;
  }
  updateEnvFile(add, file);
  console.log(`${file}: added ${keys.join(', ')} (values not shown).`);
}

if (process.argv[1] && /init-local\.[cm]?[jt]s$/.test(process.argv[1])) main();
