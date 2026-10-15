import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createGraphClient, evaluate, type Provenance } from '@adminforge/connectors';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { AppContext } from '../context';
import { AppError } from '../errors';

export const SectionError = z.object({ code: z.string(), message: z.string(), hint: z.string() });
export type SectionError = z.infer<typeof SectionError>;

const ProvenanceSchema = z.object({
  service: z.string(),
  path: z.string(),
  ms: z.number(),
  requestId: z.string().optional(),
  cachedAt: z.string().optional(),
});

/**
 * GET /api/overview. Sections that fail carry a hint instead of failing the page:
 * `health` becomes `{error}`; for org/counts/skus a fallback value is returned and `errors[section]`
 * explains why (counts that failed are null).
 */
export const OverviewResponse = z.object({
  org: z.object({
    id: z.string(),
    name: z.string(),
    domains: z.array(z.object({ name: z.string(), isDefault: z.boolean(), isInitial: z.boolean() })),
  }),
  counts: z.object({
    users: z.number().nullable(),
    groups: z.number().nullable(),
    apps: z.number().nullable(),
    devices: z.number().nullable(),
  }),
  skus: z.array(z.object({ sku: z.string(), used: z.number(), total: z.number() })),
  health: z.union([
    z.object({ items: z.array(z.object({ service: z.string(), status: z.string() })) }),
    z.object({ error: SectionError }),
  ]),
  errors: z.record(z.string(), SectionError).optional(),
  provenance: z.record(z.string(), ProvenanceSchema),
});
export type OverviewResponse = z.infer<typeof OverviewResponse>;

type SectionId = 'org' | 'users' | 'groups' | 'apps' | 'devices' | 'skus' | 'health';

const EVENTUAL = { ConsistencyLevel: 'eventual' };

/** One Graph $batch (all GETs, so read-mode policy allows it). `path` is what provenance shows. */
const BATCH: Array<{ id: SectionId; url: string; path: string; headers?: Record<string, string> }> = [
  { id: 'org', url: '/organization?$select=id,displayName,verifiedDomains', path: '/organization' },
  { id: 'users', url: '/users/$count', path: '/users/$count', headers: EVENTUAL },
  { id: 'groups', url: '/groups/$count', path: '/groups/$count', headers: EVENTUAL },
  { id: 'apps', url: '/applications/$count', path: '/applications/$count', headers: EVENTUAL },
  { id: 'devices', url: '/devices/$count', path: '/devices/$count', headers: EVENTUAL },
  { id: 'skus', url: '/subscribedSkus', path: '/subscribedSkus' },
  {
    id: 'health',
    url: '/admin/serviceAnnouncement/healthOverviews?$select=service,status',
    path: '/admin/serviceAnnouncement/healthOverviews',
  },
];

/** What to ask for when Graph says 401/403 for a section. */
const PERMISSION_HINTS: Record<SectionId, string> = {
  org: 'Needs Organization.Read.All (or User.Read) on the Read app.',
  users: 'Needs User.Read.All on the Read app.',
  groups: 'Needs Group.Read.All on the Read app.',
  apps: 'Needs Application.Read.All on the Read app.',
  devices: 'Needs Device.Read.All (or Directory.Read.All) on the Read app.',
  skus: 'Needs Organization.Read.All (or LicenseAssignment.Read.All) on the Read app.',
  health:
    'Needs ServiceHealth.Read.All on the Read app and an admin role that can read service health (e.g. Global Reader or Service Support Administrator).',
};

interface BatchResponse {
  id: string;
  status: number;
  body?: unknown;
}

export function sectionError(id: SectionId, status: number, body: unknown): SectionError {
  const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  const code = err?.code ?? `HTTP${status}`;
  const message = err?.message ?? `Microsoft Graph returned ${status}.`;
  let hint: string;
  if (status === 401 || status === 403) {
    hint = /licen[cs]|subscription|sku|premium/i.test(message)
      ? `Your tenant's licences don't include this data. ${PERMISSION_HINTS[id]}`
      : PERMISSION_HINTS[id];
  } else if (status === 429) hint = 'Microsoft Graph throttled this request. Try again in a minute.';
  else if (status >= 500) hint = 'Microsoft Graph had a temporary problem. Try again shortly.';
  else if (status === 404) hint = 'Not available for this tenant.';
  else hint = `Microsoft Graph returned ${status}.`;
  return { code, message, hint };
}

/** $count bodies arrive as a number, a numeric string, or (text/plain in a JSON batch) base64 text. */
export function parseCount(body: unknown): number | null {
  if (typeof body === 'number' && Number.isFinite(body)) return body;
  if (typeof body === 'string') {
    const s = body.trim();
    if (/^\d+$/.test(s)) return Number(s);
    const decoded = Buffer.from(s, 'base64').toString('utf8').trim();
    if (/^\d+$/.test(decoded)) return Number(decoded);
  }
  if (
    body &&
    typeof body === 'object' &&
    typeof (body as Record<string, unknown>)['@odata.count'] === 'number'
  ) {
    return (body as Record<string, number>)['@odata.count']!;
  }
  return null;
}

interface GraphOrg {
  id: string;
  displayName?: string;
  verifiedDomains?: Array<{ name: string; isDefault?: boolean; isInitial?: boolean }>;
}
interface GraphSku {
  skuPartNumber?: string;
  consumedUnits?: number;
  prepaidUnits?: { enabled?: number };
}

export function mapOverview(
  responses: BatchResponse[],
  prov: { ms: number; requestId?: string },
  session: Pick<SessionRecord, 'tenantId' | 'tenantName'>,
): OverviewResponse {
  const byId = new Map(responses.map((r) => [r.id, r]));
  const errors: Record<string, SectionError> = {};
  const ok = (id: SectionId) => {
    const r = byId.get(id);
    if (!r) {
      errors[id] = { code: 'missing', message: 'No response for this section.', hint: 'Try again shortly.' };
      return undefined;
    }
    if (r.status >= 200 && r.status < 300) return r.body;
    errors[id] = sectionError(id, r.status, r.body);
    return undefined;
  };

  const orgBody = ok('org') as { value?: GraphOrg[] } | undefined;
  const o = orgBody?.value?.[0];
  const org = o
    ? {
        id: o.id,
        name: o.displayName ?? session.tenantName,
        domains: (o.verifiedDomains ?? []).map((d) => ({
          name: d.name,
          isDefault: Boolean(d.isDefault),
          isInitial: Boolean(d.isInitial),
        })),
      }
    : { id: session.tenantId, name: session.tenantName, domains: [] };

  const count = (id: SectionId) => {
    const body = ok(id);
    if (body === undefined) return null;
    const n = parseCount(body);
    if (n === null)
      errors[id] = {
        code: 'unexpected_response',
        message: 'Graph returned a count AdminForge could not read.',
        hint: 'Try again shortly.',
      };
    return n;
  };
  const counts = {
    users: count('users'),
    groups: count('groups'),
    apps: count('apps'),
    devices: count('devices'),
  };

  const skuBody = ok('skus') as { value?: GraphSku[] } | undefined;
  const skus = (skuBody?.value ?? []).map((s) => ({
    sku: s.skuPartNumber ?? 'unknown',
    used: s.consumedUnits ?? 0,
    total: s.prepaidUnits?.enabled ?? 0,
  }));

  const healthBody = ok('health') as { value?: Array<{ service?: string; status?: string }> } | undefined;
  const health = errors.health
    ? { error: errors.health }
    : {
        items: (healthBody?.value ?? []).map((h) => ({
          service: h.service ?? 'unknown',
          status: h.status ?? 'unknown',
        })),
      };
  delete errors.health;

  const provenance: Record<string, Provenance> = {};
  for (const b of BATCH)
    provenance[b.id] = {
      service: 'graph',
      path: b.path,
      ms: prov.ms,
      ...(prov.requestId ? { requestId: prov.requestId } : {}),
    };

  return { org, counts, skus, health, ...(Object.keys(errors).length ? { errors } : {}), provenance };
}

async function loadFixture(ctx: AppContext): Promise<OverviewResponse> {
  const file = path.join(ctx.config.ADMINFORGE_FIXTURES_DIR, 'graph', 'overview.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new AppError(500, 'fixture_missing', 'The overview fixture is missing.', {
      hint: 'Set ADMINFORGE_FIXTURES_DIR to the tests/fixtures directory.',
    });
  }
  return OverviewResponse.parse(JSON.parse(text));
}

async function loadLive(
  ctx: AppContext,
  request: FastifyRequest,
  session: SessionRecord,
): Promise<OverviewResponse> {
  if (!ctx.broker) {
    throw new AppError(409, 'live_data_unavailable', 'Live data needs Entra sign-in.', {
      hint: 'Use DATA_MODE=fixtures with AUTH_MODE=mock.',
    });
  }
  const body = {
    requests: BATCH.map((b) => ({
      id: b.id,
      method: 'GET',
      url: b.url,
      ...(b.headers ? { headers: b.headers } : {}),
    })),
  };
  const decision = evaluate('read', { service: 'graph', method: 'POST', path: '/$batch', body });
  if (!decision.allowed) throw new AppError(403, 'policy_denied', decision.reason);

  const result = await ctx.broker.withToken(session, 'graph', 'read', (getToken) =>
    createGraphClient({
      getToken,
      fetch: ctx.fetch,
      correlationId: request.id,
      timeoutMs: 20_000,
      maxRetries: 2,
    }).request<{ responses: BatchResponse[] }>({
      method: 'POST',
      path: '/$batch',
      body,
    }),
  );
  return mapOverview(result.data.responses ?? [], { ms: result.ms, requestId: result.requestId }, session);
}

export function overviewRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get('/overview', async (request) => {
    const session = requireSession(request);
    return ctx.config.DATA_MODE === 'fixtures' ? loadFixture(ctx) : loadLive(ctx, request, session);
  });
}
