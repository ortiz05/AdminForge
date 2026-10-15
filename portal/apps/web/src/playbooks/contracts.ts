import { queryOptions } from '@tanstack/react-query';
import type { Params, Playbook, Runbook } from '@adminforge/schemas';
import { api } from '../lib/api';
import { arr, parser, pick, rec, str } from '../runs/json';

/**
 * Contracts the playbook drawer and runbook page read:
 *   GET /api/definitions/:kind/:key       → the client copy of a published definition (bare, or { definition, version, sha256 })
 *   GET /api/me/capabilities              → { roles: { active, eligible }, features, skus? }
 *   GET /api/search?q=&type=              → { results: [{ type, title, subtitle, href, id }] }
 */

export type AutomationKind = 'playbook' | 'runbook';

export interface LoadedDefinition<D> {
  def: D;
  version: string;
  sha256: string | null;
}

function readDefinition<D extends Playbook | Runbook>(kind: AutomationKind) {
  return parser((input): LoadedDefinition<D> => {
    const o = rec(input);
    const body = rec(o.definition ?? o.def ?? input);
    if (body.kind !== kind || typeof body.id !== 'string' || typeof body.title !== 'string')
      throw new TypeError(`Expected a ${kind} definition`);
    if (kind === 'playbook' && !Array.isArray(body.steps)) throw new TypeError('Expected playbook steps');
    if (kind === 'runbook' && !Array.isArray(body.sections)) throw new TypeError('Expected runbook sections');
    return {
      def: body as unknown as D,
      version: pick(o, 'version') ?? (typeof body.version === 'string' ? body.version : '0.0.0'),
      sha256: pick(o, 'sha256') ?? null,
    };
  });
}

/** `version` pins an exact published (or retired) version, e.g. the one a run used. */
export const definitionQuery = <D extends Playbook | Runbook>(
  kind: AutomationKind,
  key: string,
  version?: string,
) =>
  queryOptions({
    queryKey: ['definition', kind, key, version ?? 'latest'] as const,
    queryFn: ({ signal }) =>
      api(
        `/api/definitions/${kind}/${encodeURIComponent(key)}${version ? `?version=${encodeURIComponent(version)}` : ''}`,
        {
          schema: readDefinition<D>(kind),
          signal,
        },
      ),
    staleTime: 60_000,
  });

export interface DirectoryRole {
  roleDefinitionId: string;
  displayName: string;
}

export interface Capabilities {
  /** null = could not be read (no permission / licence): PIM affordances stay hidden. */
  active: DirectoryRole[] | null;
  eligible: DirectoryRole[] | null;
  /** Licensed SKUs (skuPartNumber), when the server reports them. */
  skus: string[] | null;
}

const roles = (v: unknown): DirectoryRole[] | null =>
  Array.isArray(v)
    ? v
        .map((r) => rec(r))
        .map((r) => ({
          roleDefinitionId: pick(r, 'roleDefinitionId', 'id') ?? '',
          displayName: pick(r, 'displayName', 'name') ?? pick(rec(r.roleDefinition), 'displayName') ?? '',
        }))
        .filter((r) => r.displayName)
    : null;

export const capabilitiesQuery = queryOptions({
  queryKey: ['capabilities'] as const,
  queryFn: ({ signal }) =>
    api('/api/me/capabilities', {
      signal,
      schema: parser((input): Capabilities => {
        const o = rec(input);
        const r = rec(o.roles);
        return {
          active: roles(r.active),
          eligible: roles(r.eligible),
          skus: Array.isArray(o.skus)
            ? arr(o.skus)
                .map((s) => pick(rec(s), 'skuPartNumber') ?? str(s))
                .filter((s): s is string => !!s)
            : null,
        };
      }),
    }),
  staleTime: 5 * 60_000,
  retry: false,
});

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle: string | null;
  href: string | null;
}

export const SearchResponse = parser((input): SearchResult[] =>
  arr(rec(input).results)
    .map((r) => rec(r))
    .map((r) => ({
      type: pick(r, 'type') ?? 'item',
      id: pick(r, 'id') ?? '',
      title: pick(r, 'title', 'displayName') ?? '',
      subtitle: pick(r, 'subtitle') ?? null,
      href: pick(r, 'href') ?? null,
    }))
    .filter((r) => r.id && r.title),
);

/** Inputs block of a definition (empty object when none). */
export const inputsOf = (def: { inputs?: Params }): Params => def.inputs ?? {};
