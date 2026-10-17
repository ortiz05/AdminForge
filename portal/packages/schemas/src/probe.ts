import { z } from 'zod';
import { DefinitionId, Duration, Expr, Identifier, envelopeShape, exprOr } from './common';
import { Guid } from './params';
import { KQL_SOURCES } from './constants';
import { RESOURCE_GRAPH_UNION_MESSAGE, startsWithUnion } from './datasource';

/**
 * Probes are synthetic tests (R6) run by the scheduler (and on demand). The check type lives in `check.kind`
 * (the top-level `kind` is always `probe`). `thresholds` apply to the check's primary metric (see PROBE_METRICS).
 */

const Status = z.union([
  z.number().int().min(100).max(599),
  z.array(z.number().int().min(100).max(599)).min(1),
]);

export const ProbeExpect = z.strictObject({
  /** Expected status code(s); default 2xx. */
  status: Status.optional(),
  bodyContains: z.string().optional(),
  /** Fail when slower than this (independent of thresholds). */
  maxLatencyMs: z.number().int().positive().optional(),
});

const HttpUrl = z.union([z.string().regex(/^https?:\/\/[^\s/]+/, 'Expected an http(s) URL'), Expr]);
const Host = z.union([z.string().regex(/^[A-Za-z0-9.-]+$/, 'Expected a host name'), Expr]);

export const HttpCheck = z.strictObject({
  kind: z.literal('http'),
  url: HttpUrl,
  method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  /** POST probes must say so explicitly (a POST can change the target). */
  allowPost: z.literal(true).optional(),
  expect: ProbeExpect.optional(),
});
export const GraphCheck = z.strictObject({
  kind: z.literal('graph'),
  path: z.string().regex(/^\//),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  beta: z.boolean().optional(),
  expect: ProbeExpect.optional(),
});
/**
 * Counts items in a Microsoft Graph list (automation identity, pages followed) — alert when there are too many
 * (`worse: higher`, e.g. new high-severity alerts) or too few (`worse: lower`, e.g. fewer than 2 Global Administrators).
 */
export const GraphCountCheck = z.strictObject({
  kind: z.literal('graphCount'),
  path: z.string().regex(/^\//),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  beta: z.boolean().optional(),
  /** The items to count: an expression over the list `value` (e.g. `${ value[userType = 'Guest'] }`); default all. */
  items: Expr.optional(),
  /** `higher` (default): more items is worse. `lower`: fewer items is worse. */
  worse: z.enum(['higher', 'lower']).default('higher'),
  /** Most items read (pages are followed). */
  maxItems: z.number().int().min(1).max(5000).default(1000),
  /** Item fields kept on each result row (default id, displayName). */
  fields: z.array(z.string().min(1)).min(1).max(10).optional(),
  detailsLimit: z.number().int().min(0).max(200).default(50),
});
export const ArmCheck = z.strictObject({
  kind: z.literal('arm'),
  path: z.string().regex(/^\//),
  apiVersion: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/, 'Expected an ARM api-version like 2022-12-01'),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  expect: ProbeExpect.optional(),
});
/** Acquires a token for the automation identity against the service's audience. */
export const TokenAcquisitionCheck = z.strictObject({
  kind: z.literal('tokenAcquisition'),
  service: z.enum(['graph', 'arm', 'logAnalytics', 'exchange', 'teams', 'sharepointAdmin']).optional(),
  /** Or the audience of a connection. */
  connection: DefinitionId.optional(),
});
export const CertExpiryCheck = z.strictObject({
  kind: z.literal('certExpiry'),
  host: Host,
  port: z.number().int().min(1).max(65_535).default(443),
  /** SNI name when it differs from host. */
  servername: z.string().optional(),
  warnDays: z.number().int().min(1).default(30),
  critDays: z.number().int().min(0).default(7),
});
export const DnsResolveCheck = z.strictObject({
  kind: z.literal('dnsResolve'),
  name: Host,
  type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']).default('A'),
  expect: z
    .strictObject({
      contains: z.array(z.string()).optional(),
      minAnswers: z.number().int().min(1).optional(),
    })
    .optional(),
  /** Resolver IP (default: the host's resolver). */
  resolver: z.string().optional(),
});
export const FunctionHealthCheck = z.strictObject({
  kind: z.literal('functionHealth'),
  connection: DefinitionId,
  /** Operation to call (default: the connection's `health`). */
  operation: Identifier.optional(),
  expect: ProbeExpect.optional(),
});
export const AppCredentialExpiryCheck = z.strictObject({
  kind: z.literal('appCredentialExpiry'),
  warnDays: z.number().int().min(1).default(30),
  critDays: z.number().int().min(0).default(7),
  include: z.array(z.enum(['secrets', 'certificates'])).optional(),
});
/** A skuPartNumber literal (ENTERPRISEPACK, SPE_E3) or a whole `${ env.X }` expression, so tenants keep their SKUs in configuration. */
const SkuPartNumber = z.union([
  z.string().regex(/^[A-Za-z0-9_.+-]+$/, 'Expected a skuPartNumber like SPE_E3, or ${ env.X }'),
  Expr,
]);

export const LicenseThresholdCheck = z.strictObject({
  kind: z.literal('licenseThreshold'),
  /** skuPartNumber, e.g. ENTERPRISEPACK, or `${ env.X }`. */
  sku: SkuPartNumber,
  /** Warn when consumed / enabled exceeds this percentage. */
  maxPercent: z.number().min(1).max(100),
  critPercent: z.number().min(1).max(100).optional(),
});
export const SignInHealthCheck = z.strictObject({
  kind: z.literal('signInHealth'),
  /** Look-back window, e.g. PT1H. */
  window: Duration,
  /** Fail when the failure rate over the window exceeds this percentage. */
  maxFailurePercent: z.number().min(0).max(100),
  /** Ignore windows with fewer sign-ins than this (avoids noise). */
  minSignIns: z.number().int().min(1).optional(),
  /** Restrict to one application (appId). */
  appId: z.union([Guid, Expr]).optional(),
  /**
   * Restrict to sign-ins to one resource (its appId: Office 365 Exchange Online `00000002-0000-0ff1-ce00-000000000000`,
   * Office 365 SharePoint Online `00000003-0000-0ff1-ce00-000000000000`, Microsoft Teams Services
   * `cc15fd57-2c6c-4117-a88c-83b1d56b4bbe`) — a workload's own sign-in failure rate.
   */
  resourceId: z.union([Guid, Expr]).optional(),
});

/**
 * What a synthetic transaction acts on: one whole `${ env.AF_SYNTHETIC_… }` reference — configuration naming a
 * dedicated test object, never an address or id in content, and never another configured list (recipients, approvers).
 * A mail check may also send from the report sender (`AF_MAIL_SENDER`).
 */
export function syntheticTargetKey(template: string, opts: { sender?: boolean } = {}): string | null {
  const key = /^\$\{\s*env\.([A-Z][A-Z0-9_]*)\s*\}$/.exec(template)?.[1];
  if (!key) return null;
  return /^AF_SYNTHETIC_[A-Z0-9_]+$/.test(key) || (opts.sender && key === 'AF_MAIL_SENDER') ? key : null;
}

const SyntheticTarget = (opts: { sender?: boolean } = {}) =>
  z
    .string()
    .refine(
      (v) => syntheticTargetKey(v, opts) !== null,
      opts.sender
        ? 'Use ${ env.AF_MAIL_SENDER } or one ${ env.AF_SYNTHETIC_… } reference: synthetic transactions act only on test objects named in configuration.'
        : 'Use one ${ env.AF_SYNTHETIC_… } reference: synthetic transactions act only on test objects named in configuration.',
    );

/**
 * Synthetic transaction — mail flow: sends a test message from one mailbox to a dedicated test mailbox, reads it back
 * there and deletes it. The metric is how long delivery took (seconds, end to end). Built in: content picks only the
 * two mailboxes (configuration) and the waits; the calls themselves are fixed.
 */
export const MailFlowCheck = z.strictObject({
  kind: z.literal('mailFlow'),
  /** Sending mailbox (default the report sender, which the automation identity may already send as). */
  from: SyntheticTarget({ sender: true }).default('${ env.AF_MAIL_SENDER }'),
  /** Receiving test mailbox, read back and cleaned up (never a person's mailbox). */
  to: SyntheticTarget().default('${ env.AF_SYNTHETIC_MAILBOX }'),
  /** Longest wait for the message to arrive, in seconds (also bounded by the probe's timeoutMs). */
  waitSeconds: z.number().int().min(10).max(110).default(90),
  /** Delete the test message once it arrived (needs read-write on the test mailbox). */
  cleanup: z.boolean().default(true),
});

/**
 * Synthetic transaction — files: uploads a small JSON file to a test site's default document library (SharePoint
 * Online through Microsoft Graph), downloads it from SharePoint, compares it and deletes it. Metric: the round trip.
 */
export const FileRoundTripCheck = z.strictObject({
  kind: z.literal('fileRoundTrip'),
  /** The test site's Graph id (`<host>,<site collection id>,<web id>`). */
  site: SyntheticTarget().default('${ env.AF_SYNTHETIC_SITE_ID }'),
  /** Folder in the library root that holds the test files while a check runs. */
  folder: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/, 'Use letters, digits, spaces, _ and - (at most 64)')
    .default('AdminForge synthetic checks'),
  /** Size of the test file in KB. */
  sizeKb: z.number().int().min(1).max(1024).default(16),
});

/**
 * Synthetic transaction — Teams meetings: creates an online meeting for a test user (an hour from now, half an hour
 * long) and deletes it again. Metric: how long creating it took. App-only access needs a Teams application access
 * policy granted to that user.
 */
export const OnlineMeetingCheck = z.strictObject({
  kind: z.literal('onlineMeeting'),
  /** The organiser: a test user's object id. */
  organizer: SyntheticTarget().default('${ env.AF_SYNTHETIC_USER_ID }'),
});

/** Check kinds that change something (they create and remove their own test items): synthetic transactions. */
export const TRANSACTION_KINDS = ['mailFlow', 'fileRoundTrip', 'onlineMeeting'] as const;

/** AdminForge's own audit log: re-walks the hash chain (crit when an event was changed or removed). */
export const AuditChainCheck = z.strictObject({ kind: z.literal('auditChain') });

/** Where a `kql` check runs (R12). */
export { KQL_SOURCES };
export const KqlSource = z.enum(KQL_SOURCES);
export type KqlSource = z.infer<typeof KqlSource>;

/** ISO 8601 duration only (`PT1H`, `P7D`): what Log Analytics and advanced hunting accept as a timespan. */
const IsoDuration = z
  .string()
  .regex(
    /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
    'Expected an ISO 8601 duration like PT1H or P7D',
  );

/** `rowCount` = number of rows returned; `{ column, aggregate }` = one number from a column of the result. */
export const KqlMetric = z.union([
  z.literal('rowCount'),
  z.strictObject({
    column: z.string().min(1),
    /** How the column's numeric values become one metric (default `first`: the value in the first row). */
    aggregate: z.enum(['max', 'min', 'sum', 'avg', 'first']).default('first'),
  }),
]);
export type KqlMetric = z.infer<typeof KqlMetric>;

/** Default workspace for `source: logAnalytics` checks without `workspace`. */
export const DEFAULT_LOG_ANALYTICS_WORKSPACE = '${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }';

/**
 * Configuration check in KQL (R12): Azure Resource Graph, Log Analytics, or Microsoft Defender advanced hunting, run as
 * the automation identity. `details` on the result are the first `detailsLimit` rows (the offending resources).
 * Literal text in `query` may contain `${ … }` (env, now); user data must go through `$kql()`.
 */
export const KqlCheck = z.strictObject({
  kind: z.literal('kql'),
  source: KqlSource,
  query: z.string().min(1),
  /** resourceGraph: subscriptions to query (default: every subscription the automation identity can read). */
  subscriptions: exprOr(z.array(z.string().min(1))).optional(),
  /** resourceGraph: management groups to query instead of subscriptions. */
  managementGroups: exprOr(z.array(z.string().min(1))).optional(),
  /** logAnalytics: workspace (customer) id; default `${ env.AF_LOG_ANALYTICS_WORKSPACE_ID }`. */
  workspace: z.string().min(1).optional(),
  /** logAnalytics / advancedHunting: look-back window (default P1D for Log Analytics, the service default for hunting). */
  timespan: z.union([IsoDuration, Expr]).optional(),
  metric: KqlMetric.default('rowCount'),
  /** Rows kept as `details` on each result (the violating resources), capped. */
  detailsLimit: z.number().int().min(0).max(500).default(50),
});

export const ProbeCheck = z.discriminatedUnion('kind', [
  HttpCheck,
  GraphCheck,
  GraphCountCheck,
  ArmCheck,
  TokenAcquisitionCheck,
  CertExpiryCheck,
  DnsResolveCheck,
  FunctionHealthCheck,
  AppCredentialExpiryCheck,
  LicenseThresholdCheck,
  SignInHealthCheck,
  KqlCheck,
  AuditChainCheck,
  MailFlowCheck,
  FileRoundTripCheck,
  OnlineMeetingCheck,
]);
export type ProbeCheck = z.infer<typeof ProbeCheck>;
export type ProbeCheckKind = ProbeCheck['kind'];

/** Primary metric per check kind and which direction is worse — how `thresholds` are applied. */
export const PROBE_METRICS: Record<
  ProbeCheckKind,
  { metric: string; unit: string; worse: 'higher' | 'lower' }
> = {
  http: { metric: 'latency', unit: 'ms', worse: 'higher' },
  graph: { metric: 'latency', unit: 'ms', worse: 'higher' },
  /** Items counted; which direction is worse is the check's own `worse`. */
  graphCount: { metric: 'items', unit: 'items', worse: 'higher' },
  arm: { metric: 'latency', unit: 'ms', worse: 'higher' },
  tokenAcquisition: { metric: 'latency', unit: 'ms', worse: 'higher' },
  dnsResolve: { metric: 'latency', unit: 'ms', worse: 'higher' },
  functionHealth: { metric: 'latency', unit: 'ms', worse: 'higher' },
  certExpiry: { metric: 'daysRemaining', unit: 'days', worse: 'lower' },
  appCredentialExpiry: { metric: 'daysRemaining', unit: 'days', worse: 'lower' },
  licenseThreshold: { metric: 'consumed', unit: '%', worse: 'higher' },
  signInHealth: { metric: 'failureRate', unit: '%', worse: 'higher' },
  /** Row count, or the chosen column's aggregate (unit = the column name). */
  kql: { metric: 'rows', unit: 'rows', worse: 'higher' },
  /** Events verified; the status comes from the verification, not thresholds. */
  auditChain: { metric: 'events', unit: 'events', worse: 'lower' },
  /** Seconds from sending the test message to seeing it in the test mailbox. */
  mailFlow: { metric: 'delivery', unit: 's', worse: 'higher' },
  /** Upload, download and delete together. */
  fileRoundTrip: { metric: 'latency', unit: 'ms', worse: 'higher' },
  /** Creating the meeting. */
  onlineMeeting: { metric: 'latency', unit: 'ms', worse: 'higher' },
};

export const Probe = z
  .strictObject({
    kind: z.literal('probe'),
    ...envelopeShape,
    check: ProbeCheck,
    /**
     * The service the probe watches, as Synthetic monitoring groups it (and `probeStatus` widgets with `group` pick it):
     * a navigation section key (`identity`, `m365`, `exchange`, `sharepoint`, `teams`, `endpoint`, `azure`, …) or
     * `platform` for AdminForge itself. Without it the probe is listed under "Other checks".
     */
    group: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    /** On the primary metric (PROBE_METRICS); for days-remaining metrics they override warnDays/critDays. */
    thresholds: z.strictObject({ warn: z.number().optional(), crit: z.number().optional() }).optional(),
    /** Suggested interval when scheduled without an explicit cron, e.g. PT5M. */
    intervalHint: Duration.optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  })
  .superRefine((def, ctx) => {
    const t = def.thresholds;
    if (
      def.check.kind === 'graphCount' &&
      def.check.worse === 'lower' &&
      t?.warn === undefined &&
      t?.crit === undefined
    )
      ctx.addIssue({
        code: 'custom',
        path: ['thresholds'],
        message: 'With worse: lower, set thresholds (e.g. crit: 1 for "at least 2").',
      });
    if (t?.warn !== undefined && t.crit !== undefined) {
      const worse = def.check.kind === 'graphCount' ? def.check.worse : PROBE_METRICS[def.check.kind].worse;
      if (worse === 'higher' ? t.warn > t.crit : t.warn < t.crit)
        ctx.addIssue({
          code: 'custom',
          path: ['thresholds'],
          message: `For ${def.check.kind}, ${worse} is worse: warn must be ${worse === 'higher' ? '≤' : '≥'} crit.`,
        });
    }
    const c = def.check;
    if ((c.kind === 'certExpiry' || c.kind === 'appCredentialExpiry') && c.critDays > c.warnDays)
      ctx.addIssue({ code: 'custom', path: ['check', 'critDays'], message: 'critDays must be ≤ warnDays.' });
    // The runner's default probe timeout is 30 s (DEFAULT_PROBE_TIMEOUT_MS); a mail check waits longer than that.
    if (c.kind === 'mailFlow' && (def.timeoutMs ?? 30_000) < c.waitSeconds * 1000 + 10_000)
      ctx.addIssue({
        code: 'custom',
        path: ['timeoutMs'],
        message: `A mail flow check waits up to waitSeconds (${c.waitSeconds} s) and then cleans up: set timeoutMs to at least ${c.waitSeconds * 1000 + 10_000}.`,
      });
    if (c.kind === 'tokenAcquisition' && !!c.service === !!c.connection)
      ctx.addIssue({
        code: 'custom',
        path: ['check', 'service'],
        message: 'Use exactly one of service or connection.',
      });
    if (c.kind === 'kql') {
      const only = (
        field: 'subscriptions' | 'managementGroups' | 'workspace' | 'timespan',
        sources: readonly KqlSource[],
      ) => {
        if (c[field] !== undefined && !sources.includes(c.source))
          ctx.addIssue({
            code: 'custom',
            path: ['check', field],
            message: `${field} applies to source ${sources.join(' or ')}, not ${c.source}.`,
          });
      };
      if (c.source === 'resourceGraph' && startsWithUnion(c.query))
        ctx.addIssue({ code: 'custom', path: ['check', 'query'], message: RESOURCE_GRAPH_UNION_MESSAGE });
      only('subscriptions', ['resourceGraph']);
      only('managementGroups', ['resourceGraph']);
      only('workspace', ['logAnalytics']);
      only('timespan', ['logAnalytics', 'advancedHunting']);
      if (c.subscriptions !== undefined && c.managementGroups !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['check', 'managementGroups'],
          message: 'Use subscriptions or managementGroups, not both.',
        });
    }
  });
export type Probe = z.infer<typeof Probe>;
