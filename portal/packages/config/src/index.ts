import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * AdminForge configuration lives OUTSIDE the repository (R2), in layers (lowest first):
 *   1. $ADMINFORGE_ENV_FILE, or ~/.config/adminforge/$ADMINFORGE_ENV.env (default env "dev") — runtime config;
 *   2. <same name>.admin.env — provisioner and live-test credentials, read only by admin tooling (CLI, live tests),
 *      never by the services;
 *   3. <same name>.$ADMINFORGE_ENV_OVERLAY.env — per-deployment overrides (e.g. "host": the services' own database).
 * process.env always wins over the files, so containers and CI can inject values directly.
 */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADMINFORGE_ENV_FILE) return path.resolve(env.ADMINFORGE_ENV_FILE);
  return path.join(homedir(), '.config', 'adminforge', `${env.ADMINFORGE_ENV ?? 'dev'}.env`);
}

const sibling = (file: string, suffix: string) => file.replace(/(\.env)?$/, `.${suffix}.env`);

/** Provisioner and live-test credentials: kept out of the services' configuration. */
export const ADMIN_ENV_KEYS = [
  'AF_PROVISIONER_CLIENT_ID',
  'AF_PROVISIONER_CLIENT_SECRET',
  'AF_TEST_USER_UPN',
  'AF_TEST_USER_PASSWORD',
  'AF_TEST_USER_TOTP_SECRET',
  'AF_TEST_SERVICE_ADMIN_ROLES',
  // Licensed test fixtures (`provision test-identities`): opt-ins and the second validation account.
  'AF_TEST_LICENCE_SKU',
  'AF_TEST_FIXTURES',
  'AF_TEST_APPROVER_UPN',
  'AF_TEST_APPROVER_PASSWORD',
  'AF_TEST_APPROVER_TOTP_SECRET',
] as const;

const isAdminKey = (key: string) => (ADMIN_ENV_KEYS as readonly string[]).includes(key);

/**
 * The database owner's credentials: `DATABASE_MIGRATION_URL` (written to <env>.host.env by
 * portal/deploy/db/create-app-role.sh) and `POSTGRES_PASSWORD` (the dev container's superuser, read by docker compose
 * from the env file directly). Only migrations need them; the services connect as the least-privilege role.
 */
export const OWNER_ENV_KEYS = ['DATABASE_MIGRATION_URL', 'POSTGRES_PASSWORD'] as const;

/** The admin-only file next to the env file. */
export const adminEnvFilePath = (env: NodeJS.ProcessEnv = process.env) => sibling(envFilePath(env), 'admin');

/** The overlay file for $ADMINFORGE_ENV_OVERLAY, if one is named (letters, digits and dashes only). */
export function overlayEnvFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const overlay = env.ADMINFORGE_ENV_OVERLAY;
  if (!overlay) return undefined;
  if (!/^[a-z0-9-]{1,32}$/.test(overlay))
    throw new Error('ADMINFORGE_ENV_OVERLAY must be lower-case letters, digits and dashes.');
  return sibling(envFilePath(env), overlay);
}

export interface LoadEnvOptions {
  /** Also read <env>.admin.env (provisioner and live-test credentials). Admin tooling only. */
  admin?: boolean;
  /**
   * Keep the database owner's credentials (OWNER_ENV_KEYS) found in the files. Migrations only (`db:migrate`): the
   * services, the CLI and `pnpm dev` never get them, even though they read the same files.
   */
  owner?: boolean;
}

/** The files `loadEnv` reads, lowest precedence first (missing files are skipped). */
export function envFiles(env: NodeJS.ProcessEnv = process.env, opts: LoadEnvOptions = {}): string[] {
  const overlay = overlayEnvFilePath(env);
  return [envFilePath(env), ...(opts.admin ? [adminEnvFilePath(env)] : []), ...(overlay ? [overlay] : [])];
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

/**
 * The layered files (see envFilePath) overlaid by process.env. Missing files → process.env only. Keys from the files
 * that the caller didn't ask for are dropped: admin keys without `admin` (also from a base file that still holds
 * them — older layout), owner keys without `owner`. Values set in process.env itself are kept as given.
 */
export function loadEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadEnvOptions = {},
): Record<string, string | undefined> {
  const fromFiles: Record<string, string> = {};
  for (const file of envFiles(env, opts))
    if (existsSync(file)) Object.assign(fromFiles, parseEnv(readFileSync(file, 'utf8')));
  if (!opts.admin) for (const key of ADMIN_ENV_KEYS) delete fromFiles[key];
  if (!opts.owner) for (const key of OWNER_ENV_KEYS) delete fromFiles[key];
  return { ...fromFiles, ...env };
}

/** Upserts keys in the env file (creating it 0600 if needed), preserving comments and order. */
export function updateEnvFile(updates: Record<string, string>, file = envFilePath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && pending.has(m[1]!)) {
      const value = pending.get(m[1]!)!;
      pending.delete(m[1]!);
      return `${m[1]}=${value}`;
    }
    return line;
  });
  while (next.length && next[next.length - 1] === '') next.pop();
  for (const [k, v] of pending) next.push(`${k}=${v}`);
  writeFileSync(file, `${next.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Upserts keys where they belong: admin keys in <env>.admin.env, everything else in the env file. */
export function writeEnvKeys(updates: Record<string, string>, env: NodeJS.ProcessEnv = process.env): void {
  const admin = Object.fromEntries(Object.entries(updates).filter(([k]) => isAdminKey(k)));
  const runtime = Object.fromEntries(Object.entries(updates).filter(([k]) => !isAdminKey(k)));
  if (Object.keys(runtime).length) updateEnvFile(runtime, envFilePath(env));
  if (Object.keys(admin).length) updateEnvFile(admin, adminEnvFilePath(env));
}

/** Repo root, resolved from this file (portal/packages/config/src). */
export const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');

// Which local configuration values count as tenant data (the no-tenant-data guard and `adminforge fixtures record`).
export * from './tenant-values';
