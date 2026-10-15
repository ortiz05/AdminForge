import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '@adminforge/config';

/** Directory of the @adminforge/api package, found by walking up from this module (works from src/ and dist/). */
export function apiPackageDir(from = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@adminforge/api') return dir;
    if (path.dirname(dir) === dir) throw new Error('Cannot locate the @adminforge/api package directory');
  }
}

/**
 * Workspace root. `repoRoot` from @adminforge/config is derived from its own source path, which
 * no longer holds once the API is bundled into dist/, so fall back to the API package location.
 */
export function workspaceRoot(): string {
  if (existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) return repoRoot;
  return path.resolve(apiPackageDir(), '../../..');
}

/** Drizzle migrations folder (portal/apps/api/drizzle). */
export const migrationsDir = () => path.join(apiPackageDir(), 'drizzle');
