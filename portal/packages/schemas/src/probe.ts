import { z } from 'zod';
import { DefinitionId, Duration, Expr, Identifier, envelopeShape } from './common';
import { Guid } from './params';

/**
 * Probes are synthetic tests (R6) run by the scheduler (and on demand). The check type lives in `check.kind`
 * (the top-level `kind` is always `probe`). `thresholds` apply to the check's primary metric (see PROBE_METRICS).
 */

const Status = z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599)).min(1)]);

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
  expect: ProbeExpect.optional(),
});
export const GraphCheck = z.strictObject({
  kind: z.literal('graph'),
  path: z.string().regex(/^\//),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  beta: z.boolean().optional(),
  expect: ProbeExpect.optional(),
});
export const ArmCheck = z.strictObject({
  kind: z.literal('arm'),
  path: z.string().regex(/^\//),
  apiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/, 'Expected an ARM api-version like 2022-12-01'),
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
  expect: z.strictObject({ contains: z.array(z.string()).optional(), minAnswers: z.number().int().min(1).optional() }).optional(),
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
export const LicenseThresholdCheck = z.strictObject({
  kind: z.literal('licenseThreshold'),
  /** skuPartNumber, e.g. ENTERPRISEPACK. */
  sku: z.string().min(1),
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
});

export const ProbeCheck = z.discriminatedUnion('kind', [
  HttpCheck,
  GraphCheck,
  ArmCheck,
  TokenAcquisitionCheck,
  CertExpiryCheck,
  DnsResolveCheck,
  FunctionHealthCheck,
  AppCredentialExpiryCheck,
  LicenseThresholdCheck,
  SignInHealthCheck,
]);
export type ProbeCheck = z.infer<typeof ProbeCheck>;
export type ProbeCheckKind = ProbeCheck['kind'];

/** Primary metric per check kind and which direction is worse — how `thresholds` are applied. */
export const PROBE_METRICS: Record<ProbeCheckKind, { metric: string; unit: string; worse: 'higher' | 'lower' }> = {
  http: { metric: 'latency', unit: 'ms', worse: 'higher' },
  graph: { metric: 'latency', unit: 'ms', worse: 'higher' },
  arm: { metric: 'latency', unit: 'ms', worse: 'higher' },
  tokenAcquisition: { metric: 'latency', unit: 'ms', worse: 'higher' },
  dnsResolve: { metric: 'latency', unit: 'ms', worse: 'higher' },
  functionHealth: { metric: 'latency', unit: 'ms', worse: 'higher' },
  certExpiry: { metric: 'daysRemaining', unit: 'days', worse: 'lower' },
  appCredentialExpiry: { metric: 'daysRemaining', unit: 'days', worse: 'lower' },
  licenseThreshold: { metric: 'consumed', unit: '%', worse: 'higher' },
  signInHealth: { metric: 'failureRate', unit: '%', worse: 'higher' },
};

export const Probe = z
  .strictObject({
    kind: z.literal('probe'),
    ...envelopeShape,
    check: ProbeCheck,
    /** On the primary metric (PROBE_METRICS); for days-remaining metrics they override warnDays/critDays. */
    thresholds: z.strictObject({ warn: z.number().optional(), crit: z.number().optional() }).optional(),
    /** Suggested interval when scheduled without an explicit cron, e.g. PT5M. */
    intervalHint: Duration.optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  })
  .superRefine((def, ctx) => {
    const t = def.thresholds;
    if (t?.warn !== undefined && t.crit !== undefined) {
      const worse = PROBE_METRICS[def.check.kind].worse;
      if (worse === 'higher' ? t.warn > t.crit : t.warn < t.crit)
        ctx.addIssue({ code: 'custom', path: ['thresholds'], message: `For ${def.check.kind}, ${worse} is worse: warn must be ${worse === 'higher' ? '≤' : '≥'} crit.` });
    }
    const c = def.check;
    if ((c.kind === 'certExpiry' || c.kind === 'appCredentialExpiry') && c.critDays > c.warnDays)
      ctx.addIssue({ code: 'custom', path: ['check', 'critDays'], message: 'critDays must be ≤ warnDays.' });
    if (c.kind === 'tokenAcquisition' && !!c.service === !!c.connection)
      ctx.addIssue({ code: 'custom', path: ['check', 'service'], message: 'Use exactly one of service or connection.' });
  });
export type Probe = z.infer<typeof Probe>;
