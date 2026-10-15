import { z } from 'zod';
import { Expr, HttpMethod, Identifier, Mode, envelopeShape } from './common';

/**
 * Connections describe external Entra-secured APIs (your Function Apps, §7.5). Only the named operations can be called,
 * and read sessions may only call `mode: read` operations (ADR-003). Base URL and audience are usually `${ env.X }`.
 */

const BaseUrl = z.union([
  Expr,
  z
    .string()
    .regex(
      /^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[^\s]*)?$/,
      'Expected an https:// URL (http only for localhost)',
    ),
]);
const Audience = z.union([
  Expr,
  z
    .string()
    .regex(
      /^(api:\/\/\S+|https:\/\/\S+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
      'Expected api://…, https://… or an application id',
    ),
]);

export const ConnectionOperation = z
  .strictObject({
    method: HttpMethod.default('GET'),
    /** Relative to baseUrl; `{name}` placeholders are filled from `pathParams` (encoded). */
    path: z.string().regex(/^\/[^\s?#]*$/, 'Expected a path starting with / (no query string)'),
    mode: Mode,
    description: z.string().optional(),
    /** Safe to retry on 5xx/network errors (default: GET/HEAD/PUT/DELETE). */
    idempotent: z.boolean().optional(),
  })
  .refine((op) => op.mode === 'write' || !['PUT', 'PATCH', 'DELETE'].includes(op.method), {
    message: 'PUT/PATCH/DELETE operations must be mode: write',
    path: ['mode'],
  });
export type ConnectionOperation = z.infer<typeof ConnectionOperation>;

export const Connection = z
  .strictObject({
    kind: z.literal('connection'),
    ...envelopeShape,
    baseUrl: BaseUrl,
    audience: Audience,
    /**
     * Delegated scope names on the connection's own audience (default user_impersonation). Names only: the token is
     * always requested as `<audience>/<name>`, so a scope can never point at another resource (e.g. Graph).
     */
    scopes: z
      .array(
        z
          .string()
          .regex(
            /^[A-Za-z0-9._-]+$/,
            'Expected a scope name such as user_impersonation (the audience is added automatically)',
          ),
      )
      .optional(),
    operations: z.record(Identifier, ConnectionOperation),
    /** Operation used by functionHealth probes. */
    health: Identifier.optional(),
    timeoutMs: z.number().int().min(100).max(230_000).optional(),
  })
  .superRefine((def, ctx) => {
    if (Object.keys(def.operations).length === 0)
      ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Declare at least one operation.' });
    if (def.health && !(def.health in def.operations))
      ctx.addIssue({ code: 'custom', path: ['health'], message: `Unknown operation "${def.health}".` });
  });
export type Connection = z.infer<typeof Connection>;
