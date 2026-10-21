import { homedir } from 'node:os';
import path from 'node:path';
import { ConfigError } from './errors';

/**
 * The database file the CLI opens: `explicit` (a command-line option) or DATABASE_PATH from the env file or the
 * environment, with a leading `~` expanded (init:local writes `~/.local/share/adminforge/dev.db`), as an absolute path.
 */
export function databasePath(env: Record<string, string | undefined>, explicit?: string): string {
  const file = explicit ?? env.DATABASE_PATH;
  if (!file) throw new ConfigError('DATABASE_PATH is not set (env file or environment).');
  return path.resolve(file.replace(/^~(?=$|[\\/])/, homedir()));
}
