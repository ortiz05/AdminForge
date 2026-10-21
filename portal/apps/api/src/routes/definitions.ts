import { Kind, type Definition, type NavPlacement } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { hasRole, requireSession } from '../auth/guards';
import { missingLicences, requiresBadge } from '../capabilities/licences';
import type { AppContext } from '../context';
import { clientDefinition } from '../definitions/client-safe';
import { definitionRetired, retirementNote } from '../definitions/current';
import { definitionNotFound } from '../definitions/registry';
import { AppError } from '../errors';
import { definitionHref } from './nav';

/** GET /api/definitions?kind= item (palettes, catalogs). */
export interface DefinitionSummary {
  kind: string;
  key: string;
  version: string;
  sha256: string;
  title: string;
  summary?: string;
  tags?: string[];
  owner: string;
  status?: string;
  template?: string;
  nav?: NavPlacement;
  risk?: string;
  mode?: string;
  href?: string;
  /** "Requires <licence>" when the tenant lacks a licence the definition declares. */
  badge?: string;
}

const HREF_KINDS = new Set(['page', 'dashboard', 'report', 'playbook', 'runbook']);
/** Every role in `requires.portalRoles` (one rule for pages, playbooks, exports and scheduled data). */
const allowed = (roles: string[], def: Definition) =>
  (def.requires?.portalRoles ?? []).every((r) => hasRole({ roles }, r));

export function definitionRoutes(api: FastifyInstance, ctx: AppContext) {
  /** The client-safe definition plus `version` and `sha256` (pin these when starting a run). */
  api.get<{ Params: { kind: string; key: string }; Querystring: { version?: string } }>(
    '/definitions/:kind/:key',
    async (request) => {
      const session = requireSession(request);
      const kind = Kind.safeParse(request.params.kind);
      if (!kind.success)
        throw new AppError(404, 'definition_not_found', `Unknown definition kind "${request.params.kind}".`);
      const version =
        typeof request.query.version === 'string' && request.query.version
          ? request.query.version
          : undefined;
      // No current version: a retired key says so (after the role check below), a never-published one is a 404.
      const rec =
        (await ctx.definitions.get(kind.data, request.params.key, version)) ??
        (version ? null : ((await ctx.definitions.retired?.(kind.data, request.params.key)) ?? null));
      if (!rec) throw definitionNotFound(kind.data, request.params.key, version);
      // An exact older version (a run's pinned one) also needs the roles the current version asks for: a role added
      // later can't be side-stepped by asking for the version before it.
      const current = version ? await ctx.definitions.get(kind.data, request.params.key) : null;
      for (const def of [rec.def, ...(current ? [current.def] : [])])
        if (!allowed(session.roles, def))
          throw new AppError(
            403,
            'forbidden',
            `This ${rec.kind} needs the ${def.requires!.portalRoles!.join(' and ')} role.`,
            { hint: 'Ask a portal administrator for access.' },
          );
      if (!version && rec.status === 'retired')
        throw definitionRetired(rec.def.title, undefined, retirementNote(rec.def.summary));
      return { ...clientDefinition(rec.def), version: rec.version, sha256: rec.sha256 };
    },
  );

  /** Latest version of every definition (optionally one kind) the user's roles allow. */
  api.get<{ Querystring: { kind?: string } }>('/definitions', async (request) => {
    const session = requireSession(request);
    let kind: Kind | undefined;
    if (request.query.kind) {
      const k = Kind.safeParse(request.query.kind);
      if (!k.success) throw new AppError(400, 'invalid_request', `Unknown kind "${request.query.kind}".`);
      kind = k.data;
    }
    const records = (await ctx.definitions.list(kind)).filter((r) => allowed(session.roles, r.def));
    const licences = records.some((r) => r.def.requires?.licences?.length)
      ? await ctx.licences.get({ kind: 'delegated', session, mode: 'read' }, { correlationId: request.id })
      : null;
    const items: DefinitionSummary[] = records.map(({ def, kind: k, key, version, sha256 }) => {
      const d = def as Definition & { template?: string; nav?: NavPlacement; risk?: string; mode?: string };
      const missing = missingLicences(licences, def.requires?.licences);
      return {
        kind: k,
        key,
        version,
        sha256,
        title: def.title,
        ...(def.summary ? { summary: def.summary } : {}),
        ...(def.tags ? { tags: def.tags } : {}),
        owner: def.owner,
        ...(def.status ? { status: def.status } : {}),
        ...(d.template ? { template: d.template } : {}),
        ...(d.nav ? { nav: d.nav } : {}),
        ...(d.risk ? { risk: d.risk } : {}),
        ...(d.mode ? { mode: d.mode } : {}),
        ...(HREF_KINDS.has(k) ? { href: definitionHref(k, key) } : {}),
        ...(missing?.length ? { badge: requiresBadge(missing) } : {}),
      };
    });
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
    return { items };
  });
}
