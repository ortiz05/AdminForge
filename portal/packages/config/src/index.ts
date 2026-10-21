import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * AdminForge configuration lives OUTSIDE the repository (R2), in layers (lowest first):
 *   1. $ADMINFORGE_ENV_FILE, or ~/.config/adminforge/$ADMINFORGE_ENV.env (default env "dev") — runtime config;
 *   2. <same name>.admin.env — provisioner and live-test credentials, read only by admin tooling (CLI, live tests),
 *      never by the services;
 *   3. <same name>.$ADMINFORGE_ENV_OVERLAY.env — per-deployment overrides.
 * process.env always wins over the files, so containers (Kubernetes: a Secret as environment) and CI can inject
 * values directly.
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
  // The sign-ins fixture's two accounts (tests/live/scripts/generate-sign-ins.ts).
  'AF_TEST_SIGNIN_1_UPN',
  'AF_TEST_SIGNIN_1_PASSWORD',
  'AF_TEST_SIGNIN_1_TOTP_SECRET',
  'AF_TEST_SIGNIN_2_UPN',
  'AF_TEST_SIGNIN_2_PASSWORD',
] as const;

const isAdminKey = (key: string) => (ADMIN_ENV_KEYS as readonly string[]).includes(key);

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

/** An env file other accounts on this machine could read or change (S-19). Names the file and the fix, never content. */
export class EnvFileModeError extends Error {
  constructor(
    readonly file: string,
    readonly mode: number,
  ) {
    super(
      `${file} is open to other users of this machine (mode ${mode.toString(8).padStart(3, '0')}) and holds secrets. Make it private with chmod 600 ${file}, then run the command again.`,
    );
    this.name = 'EnvFileModeError';
  }
}

/**
 * Refuses an env file with any group or world permission: it holds the Read app's secret and the token-cache key (the
 * admin file: the provisioner's credentials), and anyone who can read it holds the portal. Only regular files are
 * checked — ADMINFORGE_ENV_FILE=/dev/null (mock mode, the container image) and pipes belong to no one; in Kubernetes the
 * configuration arrives as environment variables (the Secret and the ConfigMap), never through an env file. Symlinks
 * are followed: the file they name is the one that must be private.
 */
function checkPrivate(file: string, stat: Stats | undefined): void {
  if (process.platform === 'win32' || !stat?.isFile()) return; // Windows: no POSIX modes (ACLs decide)
  const mode = stat.mode & 0o777;
  if (mode & 0o077) throw new EnvFileModeError(file, mode);
}

/** An env file's text, its mode checked on the descriptor that is read: no swap between the check and the read. */
function readPrivateEnvFile(file: string): string {
  const fd = openSync(file, 'r');
  try {
    checkPrivate(file, fstatSync(fd));
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * The layered files (see envFilePath) overlaid by process.env. Missing files → process.env only. Keys from the files
 * that the caller didn't ask for are dropped: admin keys without `admin` (also from a base file that still holds
 * them — older layout). Values set in process.env itself are kept as given. A file others may read is refused
 * (checkPrivate) — only the files read: without `admin`, the admin file's mode is not looked at.
 */
export function loadEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadEnvOptions = {},
): Record<string, string | undefined> {
  const fromFiles: Record<string, string> = {};
  for (const file of envFiles(env, opts))
    if (existsSync(file)) Object.assign(fromFiles, parseEnv(readPrivateEnvFile(file)));
  if (!opts.admin) for (const key of ADMIN_ENV_KEYS) delete fromFiles[key];
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
  const pick = (keep: (k: string) => boolean) =>
    Object.fromEntries(Object.entries(updates).filter(([k]) => keep(k)));
  const runtime = pick((k) => !isAdminKey(k));
  const admin = pick(isAdminKey);
  if (Object.keys(runtime).length) updateEnvFile(runtime, envFilePath(env));
  if (Object.keys(admin).length) updateEnvFile(admin, adminEnvFilePath(env));
}

/** Removes keys from one env file (comments and order kept; a missing file is left alone). */
export function removeEnvKeys(keys: readonly string[], file: string): void {
  if (!existsSync(file)) return;
  const drop = new Set(keys);
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !(m && drop.has(m[1]!));
    });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Repo root, resolved from this file (portal/packages/config/src). */
export const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');

// Which local configuration values count as tenant data (the no-tenant-data guard and `adminforge fixtures record`).
export * from './tenant-values';
