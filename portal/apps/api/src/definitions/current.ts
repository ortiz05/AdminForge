import type { DefinitionOf, Kind } from '@adminforge/schemas';
import { AppError } from '../errors';
import type { DefinitionRegistry, DefinitionSource, ResolvedDefinition } from './types';

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

/** Where to go instead of a retired definition (its note names a successor when there is one). */
export const RETIRED_HINT = 'Open what you need from the navigation, or search for it.';

/**
 * Why a definition was retired, from its summary: content writes `Retired — <why, or what replaced it>. <the old
 * summary>` (e.g. "Retired — replaced by Create group (identity.create-group)."), so the note is the first sentence
 * after "Retired". Undefined when the summary doesn't start that way.
 */
export function retirementNote(summary: string | undefined): string | undefined {
  const m = /^\s*Retired\b[\s—–:-]*(\S.*?[.!?])(?=\s|$)/su.exec(summary ?? '');
  if (!m) return undefined;
  const note = m[1]!.replace(/\s+/g, ' ');
  return note.charAt(0).toUpperCase() + note.slice(1);
}

/** 409 `definition_retired`: "<title> is retired[ and <what>]. <note>", with where to go instead. */
export const definitionRetired = (title: string, what?: string, note?: string) =>
  new AppError(
    409,
    'definition_retired',
    `${title} is retired${what ? ` and ${what}` : ''}.${note ? ` ${note}` : ''}`,
    { hint: RETIRED_HINT },
  );

/** The retired latest version of `key` (first match across `kinds`), when the registry can tell. */
export async function retiredLatest<K extends Kind>(
  registry: Pick<DefinitionSource, 'retired'>,
  kinds: readonly K[],
  key: string,
) {
  for (const kind of kinds) {
    const r = await registry.retired?.(kind, key);
    if (r) return r;
  }
  return null;
}

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
  registry: Pick<DefinitionRegistry, 'resolveAny' | 'retired'>,
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
    if (!(err instanceof AppError) || err.status !== 404) throw err;
    const retired = await retiredLatest(registry, kinds, key);
    const note = retirementNote(retired?.def.summary);
    if (version) {
      const old = await registry.resolveAny(kinds, key, version);
      throw definitionRetired(old.def.title, opts.retired, note);
    }
    if (retired) throw definitionRetired(retired.def.title, opts.retired, note);
    throw err;
  }
  if (version && version !== current.version)
    throw versionSuperseded(current.def.title, current.version, opts.hint);
  return current;
}
