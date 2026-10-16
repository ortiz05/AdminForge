import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '@adminforge/config';

/**
 * Where live output goes: Playwright results, screenshots, failure screenshots of the scripts. Screenshots of a real
 * tenant show names and data, so the directory is private to the user and outside the repository:
 *
 * - `AF_LIVE_OUT` when set (must not be inside the repository — it is refused there);
 * - otherwise `$XDG_CACHE_HOME/adminforge/live` (`~/.cache/adminforge/live`): per user, not the shared `/tmp`.
 *
 * `liveOutDir(...parts)` creates directories on demand with mode 0700. Used by e2e/playwright.config.ts,
 * e2e/portal.live.spec.ts and the scripts' failure screenshots; tested in tests/unit/live/output.test.ts.
 */

/** The live output root (see above), for `env` (default: the process environment). Not created. */
export function liveOutRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env.AF_LIVE_OUT?.trim();
  const root = explicit
    ? path.resolve(explicit)
    : path.join(env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache'), 'adminforge', 'live');
  assertOutsideRepo(root, 'AF_LIVE_OUT points inside the repository');
  return root;
}

/** The deepest existing ancestor of `p`, resolved through symlinks (so a link into the checkout is caught). */
function resolvedExisting(p: string): string {
  let dir = path.resolve(p);
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const rest = path.relative(dir, path.resolve(p));
  return path.join(realpathSync(dir), rest);
}

/**
 * Refuses a path inside the repository — compared after resolving symlinks on both sides, because screenshots are
 * binary and the tenant-data guard can't read them, so a link into the checkout would let them be committed.
 */
export function assertOutsideRepo(target: string, what = 'Live output path is inside the repository'): void {
  const rel = path.relative(realpathSync(repoRoot), resolvedExisting(target));
  if (!rel.startsWith('..') && !path.isAbsolute(rel))
    throw new Error(`${what}: live output can show tenant data. Choose a directory outside it.`);
}

/** A screenshot path given on the command line: refused inside the repository, like AF_LIVE_OUT. */
export function liveOutFile(explicit: string | undefined, fallbackName: string): string {
  if (explicit) {
    assertOutsideRepo(explicit, 'The screenshot path is inside the repository');
    return path.resolve(explicit);
  }
  return path.join(liveOutDir(), fallbackName);
}

/** The directory `<root>/<parts…>`, created (0700) if missing. */
export function liveOutDir(...parts: string[]): string {
  const root = liveOutRoot();
  const dir = path.join(root, ...parts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to directories it creates: keep an existing root private too.
  chmodSync(root, 0o700);
  return dir;
}
