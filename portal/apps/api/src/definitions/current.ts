import type { DefinitionOf, Kind } from '@adminforge/schemas';
import { AppError } from '../errors';
import type { DefinitionRegistry, ResolvedDefinition } from './types';

/**
 * Interactive calls (running a playbook, loading a page's data, exporting a report) use the **current** published
 * version only. Older rows stay resolvable by exact version for runs that pinned them and for history, but an older
 * version may lack roles, licences, approvals or fixes added since — and a retired one must not be used at all.
 */

export const versionSuperseded = (title: string, current: string, hint: string) =>
  new AppError(
    409,
    'version_superseded',
    `${title} was updated (version ${current}) since this page loaded.`,
    {
      hint,
    },
  );

export const definitionRetired = (title: string, what: string) =>
  new AppError(409, 'definition_retired', `${title} is retired and ${what}.`);

/** What the person should do after `version_superseded`, per kind of call. */
export const RELOAD_HINT = {
  run: 'Reload the page to use the current version, then preview and run it again.',
  page: 'Reload the page to use the current version.',
} as const;

/**
 * The current version of `key` (first match across `kinds`). With `version` (what the browser loaded), a different
 * current version is a 409 `version_superseded`; a key whose versions are all retired is a 409 `definition_retired`;
 * a key never published is the usual 404.
 */
export async function resolveCurrent<K extends Kind>(
  registry: Pick<DefinitionRegistry, 'resolveAny'>,
  kinds: readonly K[],
  key: string,
  version: string | undefined,
  opts: { hint: string; retired: string },
): Promise<ResolvedDefinition<DefinitionOf<K>> & { kind: K }> {
  let current: ResolvedDefinition<DefinitionOf<K>> & { kind: K };
  try {
    current = await registry.resolveAny(kinds, key);
  } catch (err) {
    // No current version: retired (the exact older version still resolves) or never published (404 stands).
    if (version && err instanceof AppError && err.status === 404) {
      const old = await registry.resolveAny(kinds, key, version);
      throw definitionRetired(old.def.title, opts.retired);
    }
    throw err;
  }
  if (version && version !== current.version)
    throw versionSuperseded(current.def.title, current.version, opts.hint);
  return current;
}
