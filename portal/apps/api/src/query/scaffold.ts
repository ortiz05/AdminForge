import {
  DEFAULT_LOG_ANALYTICS_WORKSPACE,
  DefinitionId,
  formatContentError,
  KqlMetric,
  KqlSource,
  parseDefinition,
  TimeZone,
  validateCron,
} from '@adminforge/schemas';
import { stringify } from 'yaml';
import { z } from 'zod';
import { AppError } from '../errors';

/**
 * "Save as report / probe / schedule" from Query Studio (R12): turns a KQL query into content YAML the engineer commits
 * through the normal review workflow (the same layout `adminforge new` uses). Nothing is written server-side; the YAML
 * is validated with the content schemas before it is returned.
 */

export const ScaffoldRequest = z
  .object({
    as: z.enum(['report', 'probe', 'schedule']),
    source: KqlSource,
    query: z.string().trim().min(1).max(100_000),
    title: z.string().trim().min(1).max(120),
    /** `<section>.<name>`; default derived from the title. */
    key: DefinitionId.optional(),
    summary: z.string().trim().max(500).optional(),
    owner: z.string().trim().min(1).max(100).optional(),
    /**
     * Resource Graph scope: `all` (default) = every subscription the identity can read; `default` =
     * `${ env.AF_SUBSCRIPTION_ID }`. Literal subscription or workspace ids in the body (`subscriptions`, `workspace`)
     * are ignored: ids are configuration, never content (R2).
     */
    scope: z.enum(['all', 'default']).optional(),
    /** Env key holding the Log Analytics workspace id (default AF_LOG_ANALYTICS_WORKSPACE_ID). */
    workspaceEnv: z
      .string()
      .regex(/^AF_[A-Z0-9_]+$/)
      .optional(),
    timespan: z
      .string()
      .regex(/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/)
      .optional(),
    /** Report table columns (Query Studio passes the result columns). */
    columns: z
      .array(z.object({ name: z.string().min(1).max(200), type: z.string().max(40).optional() }))
      .max(60)
      .optional(),
    // probe
    metric: KqlMetric.optional(),
    thresholds: z.object({ warn: z.number().optional(), crit: z.number().optional() }).optional(),
    detailsLimit: z.number().int().min(0).max(500).optional(),
    // schedule
    cron: z.string().optional(),
    timezone: TimeZone.optional(),
    /** What the schedule runs (default: a probe with this key). */
    job: z.object({ kind: z.enum(['probe', 'report']), ref: DefinitionId }).optional(),
  })
  .loose();
export type ScaffoldRequest = z.infer<typeof ScaffoldRequest>;

/** A tenant-specific configuration value the generated YAML must never contain (R2). */
export interface TenantValue {
  /** What it is, for messages: "the tenant id", "a subscription id", … (never the value). */
  kind: string;
  value: string;
}

const GUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ONMICROSOFT = /[a-z0-9-]+\.onmicrosoft\.(com|us|de)\b/i;

/**
 * Throws 400 `tenant_value_in_query` when user text that would land in the YAML holds a configured tenant value, a
 * GUID, or an onmicrosoft.com domain. The message names the kind and the field, never the value.
 */
export function assertNoTenantValues(
  fields: Record<string, string | undefined>,
  known: readonly TenantValue[],
): void {
  const values = known.filter((k) => k.value && k.value.trim().length >= 4);
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    const lower = text.toLowerCase();
    const hit = values.find((k) => lower.includes(k.value.trim().toLowerCase()));
    const kind =
      hit?.kind ??
      (GUID_IN_TEXT.test(text)
        ? 'a GUID (object, subscription, tenant or workspace id)'
        : ONMICROSOFT.test(text)
          ? 'a tenant domain'
          : undefined);
    if (kind)
      throw new AppError(
        400,
        'tenant_value_in_query',
        `The ${field} contains ${kind}. Content never holds tenant values, so it cannot be saved as YAML.`,
        {
          hint: 'Parameterise it: use an env key from config/example.env (for example ${ env.AF_SUBSCRIPTION_ID }) or a param quoted with $kql(), then save again.',
        },
      );
  }
}

export interface ScaffoldResult {
  yaml: string;
  /** Where to commit it, relative to the repository root. */
  path: string;
  key: string;
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'query';

/** KQL text is literal content: escape `${` so it is never read as an expression. */
const literal = (s: string) => s.replace(/\$\{/g, () => '$${');

const COLUMN_KIND: Record<string, string> = {
  datetime: 'datetime',
  date: 'datetime',
  timestamp: 'datetime',
  long: 'number',
  int: 'number',
  real: 'number',
  double: 'number',
  decimal: 'number',
  bool: 'boolean',
  boolean: 'boolean',
  guid: 'guid',
  dynamic: 'code',
};

const label = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

function contentPath(kind: 'report' | 'probe' | 'schedule', key: string): { path: string; schema: string } {
  const [section, ...rest] = key.split('.');
  const name = rest.join('.');
  const folder = { report: 'reports', probe: 'probes', schedule: 'schedules' }[kind];
  const flat = kind === 'probe' && section === 'probes';
  const rel = flat ? `${folder}/${name}.${kind}.yaml` : `${folder}/${section}/${name}.${kind}.yaml`;
  const depth = rel.split('/').length - 1;
  return {
    path: `portal/content/${rel}`,
    schema: `${'../'.repeat(depth + 1)}packages/schemas/generated/${kind}.schema.json`,
  };
}

function defaultKey(r: ScaffoldRequest): string {
  const section =
    r.as === 'probe'
      ? 'probes'
      : r.as === 'schedule'
        ? 'kql'
        : r.source === 'advancedHunting'
          ? 'security'
          : 'azure';
  return `${section}.${slug(r.title)}`;
}

const DEFAULT_SUBSCRIPTION = ['${ env.AF_SUBSCRIPTION_ID }'];

function datasource(r: ScaffoldRequest, workspace: string): Record<string, unknown> {
  const query = literal(r.query);
  if (r.source === 'resourceGraph')
    return {
      source: 'resourceGraph',
      query,
      ...(r.scope === 'default' ? { subscriptions: DEFAULT_SUBSCRIPTION } : {}),
      paging: 'all',
      maxItems: 5000,
      cache: { ttl: 300 },
    };
  if (r.source === 'logAnalytics')
    return { source: 'logAnalytics', workspace, timespan: r.timespan ?? 'P1D', query, cache: { ttl: 300 } };
  return {
    source: 'graph',
    request: {
      method: 'POST',
      path: '/security/runHuntingQuery',
      body: { Query: query, ...(r.timespan ? { Timespan: r.timespan } : {}) },
    },
    transform: '${ value.results }',
    cache: { ttl: 300 },
  };
}

/**
 * The YAML for a report, probe or schedule built from a query; throws 400 when user text holds a tenant value
 * (`known` = the installation's configured ids and domains) or when the result would not validate.
 */
export function scaffoldFromQuery(r: ScaffoldRequest, known: readonly TenantValue[] = []): ScaffoldResult {
  assertNoTenantValues(
    {
      query: r.query,
      title: r.title,
      summary: r.summary,
      owner: r.owner,
      key: r.key,
      columns: r.columns?.map((c) => c.name).join(' '),
      job: r.job?.ref,
      metric: typeof r.metric === 'object' ? r.metric.column : undefined,
    },
    known,
  );
  const key = r.key ?? defaultKey(r);
  const { path, schema } = contentPath(r.as, key);
  const workspace = r.workspaceEnv ? `\${ env.${r.workspaceEnv} }` : DEFAULT_LOG_ANALYTICS_WORKSPACE;
  const owner = r.owner ?? (r.source === 'advancedHunting' ? 'security-team' : 'azure-team');
  const header = {
    $schema: schema,
    kind: r.as,
    id: key,
    version: '0.1.0',
    title: r.title,
    summary: r.summary ?? `TODO — what this ${r.as} is for. Scaffolded from Query Studio (${r.source}).`,
    owner,
    tags: ['kql', r.source],
  };
  // Probes and schedules run as the automation identity (Azure RBAC on the workspace); reports run delegated (Data.Read).
  const requires =
    r.source === 'resourceGraph'
      ? { azureRoles: ['Reader'] }
      : r.source === 'logAnalytics'
        ? {
            ...(r.as === 'report' ? { scopes: { logAnalytics: ['Data.Read'] } } : {}),
            azureRoles: ['Log Analytics Reader'],
          }
        : { scopes: { graph: ['ThreatHunting.Read.All'] }, licences: ['defender'] };

  let doc: Record<string, unknown>;
  if (r.as === 'report') {
    const data = r.source === 'advancedHunting' ? 'rows' : 'rows.value';
    const columns = (r.columns?.length ? r.columns : [{ name: 'name', type: 'string' }]).map((c) => {
      const kind = COLUMN_KIND[(c.type ?? '').toLowerCase()];
      return {
        field: c.name,
        label: label(c.name),
        ...(kind ? { kind } : {}),
        ...(/^id$|resourceid$/i.test(c.name) ? { hidden: true } : {}),
      };
    });
    const ds = datasource(r, workspace);
    if (r.source === 'resourceGraph') ds.query = `// af:${key}#rows\n${ds.query as string}`;
    doc = {
      ...header,
      requires: {
        portalRoles: ['Portal.Reader'],
        ...(r.source === 'resourceGraph' ? { scopes: { arm: ['user_impersonation'] } } : {}),
        ...requires,
      },
      datasources: { rows: ds },
      layout: [{ widget: 'table', id: 'rows', span: 12, data, columns, search: true }],
      export: { formats: ['csv', 'xlsx'], fileName: slug(r.title), data, columns: 'all' },
    };
  } else if (r.as === 'probe') {
    doc = {
      ...header,
      tags: ['kql', 'configuration', 'config-check'],
      check: {
        kind: 'kql',
        source: r.source,
        query: literal(r.query),
        ...(r.source === 'resourceGraph' && r.scope === 'default'
          ? { subscriptions: DEFAULT_SUBSCRIPTION }
          : {}),
        ...(r.source === 'logAnalytics' && r.workspaceEnv ? { workspace } : {}),
        ...(r.source !== 'resourceGraph' && r.timespan ? { timespan: r.timespan } : {}),
        metric: r.metric ?? 'rowCount',
        detailsLimit: r.detailsLimit ?? 50,
      },
      thresholds: r.thresholds ?? { warn: 1, crit: 10 },
      intervalHint: 'PT6H',
      timeoutMs: 60000,
      requires,
    };
  } else {
    const cron = r.cron ?? '0 6 * * *';
    const err = validateCron(cron);
    if (err) throw new AppError(400, 'invalid_request', err);
    const job = r.job ?? { kind: 'probe', ref: `probes.${slug(r.title)}` };
    doc = {
      ...header,
      tags: ['kql'],
      cron,
      timezone: r.timezone ?? 'UTC',
      // Runs as the automation identity (ADR-011). Enable after review.
      enabled: false,
      identity: 'automation',
      job:
        job.kind === 'probe'
          ? { kind: 'probe', ref: job.ref }
          : { kind: 'report', ref: job.ref, delivery: [{ type: 'file', format: 'xlsx', retain: 30 }] },
      timeoutSeconds: 900,
      overlap: 'skip',
      requires,
    };
  }
  const scopeNote =
    r.source === 'resourceGraph' && r.as !== 'schedule' && r.scope !== 'default'
      ? '# Scope: every subscription the identity can read. To limit it, add subscriptions: ["${ env.AF_SUBSCRIPTION_ID }"].\n'
      : '';
  const yaml = `# Scaffolded by Query Studio. Review, then commit under ${path} (adminforge validate).\n${scopeNote}${stringify(doc, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' })}`;
  const parsed = parseDefinition(yaml, path.replace(/^portal\/content\//, ''));
  if (!parsed.ok)
    throw new AppError(
      400,
      'invalid_scaffold',
      `The ${r.as} would not be valid: ${parsed.errors.slice(0, 3).map(formatContentError).join('; ')}`,
    );
  return { yaml, path, key };
}
