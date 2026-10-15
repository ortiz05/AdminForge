import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * AdminForge configuration lives OUTSIDE the repository (R2):
 *   $ADMINFORGE_ENV_FILE, or ~/.config/adminforge/$ADMINFORGE_ENV.env (default env "dev").
 * process.env always wins over the file, so containers and CI can inject values directly.
 */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADMINFORGE_ENV_FILE) return path.resolve(env.ADMINFORGE_ENV_FILE);
  return path.join(homedir(), '.config', 'adminforge', `${env.ADMINFORGE_ENV ?? 'dev'}.env`);
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

/** File values overlaid by process.env. Missing file → process.env only. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const file = envFilePath(env);
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...env };
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

/** Repo root, resolved from this file (portal/packages/config/src). */
export const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
