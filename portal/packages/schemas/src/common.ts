import { z } from 'zod';
import { PortalRole } from './api';

/**
 * Shared building blocks for every content kind (§7.2).
 *
 * Expression convention (§7.6): anything inside `${ … }` is a JSONata expression and everything else is literal text.
 * A string that is exactly one `${ … }` evaluates to a typed value; mixed strings interpolate to a string.
 * Write `$${` for a literal `${`. Fields that can only ever be an expression (`when`, `that`, `if`, `items`,
 * `transform`, …) must be a single `${ … }`.
 */

/** Content kinds. The file suffix matches the kind: `<name>.<kind>.yaml` (navigation is `navigation.yaml`). */
export const KINDS = [
  'page',
  'dashboard',
  'report',
  'playbook',
  'runbook',
  'schedule',
  'probe',
  'connection',
  'navigation',
] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

/** Stable definition key `<section>.<name>` (lower-case kebab segments; portal-authored content uses a `local.` prefix). */
export const DefinitionId = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/,
    'Use <section>.<name> in lower-case kebab segments, e.g. identity.disable-user',
  );

/** Keys that JSONata reaches with dot paths (`params.q`, `steps.lookup.output`) must be plain identifiers. */
export const Identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and _ only (it is referenced from expressions)');

export const SemVer = z
  .string({ error: 'Expected a semver string like 1.0.0 (quote it in YAML if needed)' })
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    'Expected a semver version like 1.2.0',
  );

/** Authoring status (default `active`). `draft` is hidden from navigation; `retired` hides the item but keeps history (§7.9). */
export const ContentStatus = z.enum(['draft', 'preview', 'active', 'deprecated', 'retired']);
export type ContentStatus = z.infer<typeof ContentStatus>;

/** A string that is exactly one `${ … }` expression. */
export const Expr = z
  .string()
  .regex(/^\s*\$\{[\s\S]*\}\s*$/, 'Expected a single ${ … } expression')
  .meta({ description: 'A JSONata expression wrapped in ${ … }' });
export type Expr = z.infer<typeof Expr>;

/** Literal value or a whole `${ … }` expression that evaluates to one. */
export const exprOr = <T extends z.ZodType>(schema: T) => z.union([schema, Expr]);

/** Free text that may contain `${ … }` segments (interpolated to a string). */
export const Template = z.string();

/** Any JSON value; strings inside may be templates. */
export const TemplateValue = z.unknown();

export const HttpMethod = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
export type HttpMethod = z.infer<typeof HttpMethod>;
export const SAFE_METHODS: readonly HttpMethod[] = ['GET', 'HEAD'];

export const Mode = z.enum(['read', 'write']);
export type Mode = z.infer<typeof Mode>;

const DURATION_RE =
  /^(P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?|\d+(ms|s|m|h|d))$/;

/** ISO 8601 duration (`PT4H`, `P7D`) or shorthand (`500ms`, `30s`, `15m`, `4h`, `7d`). */
export const Duration = z
  .string()
  .regex(DURATION_RE, 'Expected a duration like PT15M, P7D, 30s, 15m, 4h or 7d');
export type Duration = z.infer<typeof Duration>;

/** Converts a Duration to milliseconds (months = 30 days, years = 365 days). Throws on invalid input. */
export function parseDuration(value: string): number {
  const short = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (short)
    return (
      Number(short[1]) *
      { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[short[2] as 'ms' | 's' | 'm' | 'h' | 'd']
    );
  const iso =
    /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!iso) throw new Error(`Invalid duration: ${value}`);
  const [, y, mo, w, d, h, mi, s] = iso.map((p) => (p === undefined ? 0 : Number(p)));
  return ((((y! * 365 + mo! * 30 + w! * 7 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

const SCOPE = z.string().regex(/^[A-Za-z0-9._:/-]+$/, 'Expected a permission/scope name like User.Read.All');

/** Permissions a definition needs, per Entra resource. `adminforge validate --scopes` checks these against the app registrations. */
export const Scopes = z.strictObject({
  graph: z.array(SCOPE).optional(),
  arm: z.array(SCOPE).optional(),
  logAnalytics: z.array(SCOPE).optional(),
  exchange: z.array(SCOPE).optional(),
  teams: z.array(SCOPE).optional(),
  sharepointAdmin: z.array(SCOPE).optional(),
  runner: z.array(SCOPE).optional(),
  /** Entra-secured APIs reached through a `connection`, keyed by connection id. */
  connections: z.record(DefinitionId, z.array(SCOPE)).optional(),
});
export type Scopes = z.infer<typeof Scopes>;

/**
 * What a definition needs to be offered and to work (§5.4).
 * `portalRoles` gate features; `scopes` are verified against the app registrations (or the automation identity for schedules);
 * `entraRoles` / `azureRoles` are advisory (preflight + "Activate in PIM"); `licences` are SKU part numbers or service plan names
 * that, when missing, render a "Requires <licence>" state instead of an error (R10).
 */
export const Requires = z.strictObject({
  portalRoles: z.array(PortalRole).optional(),
  scopes: Scopes.optional(),
  entraRoles: z.array(z.string().min(1)).optional(),
  /** Advisory Azure RBAC roles on the target scope (e.g. Reader, Website Contributor). */
  azureRoles: z.array(z.string().min(1)).optional(),
  licences: z.array(z.string().min(1)).optional(),
});
export type Requires = z.infer<typeof Requires>;

/** Phosphor icon name in kebab-case (e.g. `users`, `shield-check`). */
export const IconName = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use a Phosphor icon name in kebab-case, e.g. shield-check');

/** Retry policy for transient failures (429/5xx/network). Graph Retry-After is always honoured on top. */
export const RetryPolicy = z.strictObject({
  max: z.number().int().min(0).max(10),
  backoff: z.enum(['fixed', 'exponential']).default('exponential'),
  /** First delay (default 1s). */
  delay: Duration.optional(),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

/** Fields shared by every kind (§7.2). */
export const envelopeShape = {
  /** Editor autocomplete only (path to the generated JSON Schema). */
  $schema: z.string().optional(),
  id: DefinitionId,
  version: SemVer,
  title: z.string().min(1).max(120),
  summary: z.string().max(500).optional(),
  /** Team or group that reviews changes (CODEOWNERS). */
  owner: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  requires: Requires.optional(),
  status: ContentStatus.optional(),
};

/** Navigation placement for pages, dashboards, reports, playbooks and runbooks. */
export const NavPlacement = z.strictObject({
  /** Key of a section in navigation.yaml. */
  section: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1).optional(),
  icon: IconName.optional(),
  order: z.number().int().optional(),
  hidden: z.boolean().optional(),
});
export type NavPlacement = z.infer<typeof NavPlacement>;

/** Formats a zod/YAML path as `steps[2].request.path`. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else {
      const key = String(seg);
      out += /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? (out ? `.${key}` : key) : `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}
