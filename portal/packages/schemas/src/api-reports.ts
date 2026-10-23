import { z } from 'zod';
import { DefinitionId } from './common';
import { ScheduleIdentity, TimeZone } from './schedule';

/**
 * Contracts of the Reports catalogue and in-app report schedules:
 * - GET  /api/reports              → ReportCatalogResponse (Portal.Reader; only reports the caller may open)
 * - GET  /api/reports/:key         → ReportDetailResponse (adds the columns an export contains)
 * - GET  /api/schedules/delivery-options → DeliveryOptionsResponse (Portal.Operator; configured key names only)
 * - POST /api/schedules, PUT /api/schedules/:key → PortalScheduleRequest (Portal.Operator; report jobs only)
 * Response objects are non-strict: fields may be added, never removed or renamed.
 */

/** A report param as the schedule form shows it (hidden params are omitted). */
export const ReportParamInfo = z.object({
  name: z.string(),
  type: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  /** Literal defaults only (an expression default is null: it is evaluated when the report runs). */
  default: z.unknown().nullable(),
  required: z.boolean(),
  multiple: z.boolean(),
  /** Enum choices; null for other types. */
  values: z
    .array(z.object({ value: z.union([z.string(), z.number(), z.boolean()]), label: z.string() }))
    .nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** string/number/boolean/enum without an entity picker; other params keep the report's default when scheduled. */
  schedulable: z.boolean(),
});
export type ReportParamInfo = z.infer<typeof ReportParamInfo>;

/** A schedule (content or portal) that runs a report. */
export const ScheduleSummary = z.object({
  key: z.string(),
  title: z.string(),
  cron: z.string(),
  cronText: z.string().nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  source: z.enum(['content', 'portal']),
  /** Creator's UPN (portal schedules); null for content. */
  createdBy: z.string().nullable(),
  /** Whether the caller may edit or delete it (portal schedule; Operator; the creator or Portal.Admin). */
  canManage: z.boolean(),
  pendingApprovalId: z.string().nullable(),
  /** Who it runs as (ADR-014); absent from an older API = the automation identity. */
  runsAs: z
    .object({
      kind: z.enum(['automation', 'app', 'user']),
      name: z.string().nullable(),
      label: z.string(),
      signIn: z.enum(['signed_in', 'needs_sign_in', 'not_signed_in']).optional(),
      canSignIn: z.boolean().optional(),
      /**
       * Where the account comes from: set on this schedule in the portal (`override`, with who and when), named by its
       * definition, the installation default for its kind, or none of them (the automation identity).
       */
      source: z.enum(['override', 'definition', 'default', 'automation']).optional(),
      setBy: z.string().optional(),
      setAt: z.string().optional(),
      /** With an override: the account "Default" would mean (its definition's or the installation default). */
      defaultLabel: z.string().optional(),
    })
    .optional(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummary>;

export const ReportCatalogItem = z.object({
  key: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  owner: z.string(),
  version: z.string(),
  /** The report's `area`, else the first segment of its key (identity, m365, exchange, endpoint, billing, …). */
  area: z.string(),
  /** `nav.icon` (Phosphor kebab name). */
  icon: z.string().nullable(),
  /** /p/<key> */
  href: z.string(),
  requires: z.object({
    licences: z.array(z.string()),
    entraRoles: z.array(z.string()),
    portalRoles: z.array(z.string()),
    scopes: z.record(z.string(), z.array(z.string())),
  }),
  /** "Requires …" when the tenant lacks a declared licence (as the navigation shows it). */
  badge: z.string().nullable(),
  /** `export.formats` ([] when the report declares no export). */
  exportFormats: z.array(z.string()),
  /** Has an export, so it can be scheduled. */
  schedulable: z.boolean(),
  params: z.array(ReportParamInfo),
  /** Every schedule whose job is `{ kind: report, ref: key }`. */
  schedules: z.array(ScheduleSummary),
});
export type ReportCatalogItem = z.infer<typeof ReportCatalogItem>;

export const ReportArea = z.object({ key: z.string(), label: z.string(), icon: z.string() });
export type ReportArea = z.infer<typeof ReportArea>;

/** GET /api/reports */
export const ReportCatalogResponse = z.object({
  items: z.array(ReportCatalogItem),
  /** Areas present, in navigation order (label and icon from navigation.yaml). */
  areas: z.array(ReportArea),
});
export type ReportCatalogResponse = z.infer<typeof ReportCatalogResponse>;

/** GET /api/reports/:key */
export const ReportDetailResponse = ReportCatalogItem.extend({
  /** What an export contains. */
  columns: z.array(z.object({ field: z.string(), label: z.string() })),
});
export type ReportDetailResponse = z.infer<typeof ReportDetailResponse>;

const DeliveryList = z.object({ key: z.string(), label: z.string() });

/**
 * Who schedules may run as here (ADR-014): the configured app identities (names) and whether a schedule can run with
 * its creator's own access (Entra sign-in configured). Also GET /api/schedules/identities (Portal.Reader).
 */
export const ScheduleIdentityOptions = z.object({ apps: z.array(z.string()), user: z.boolean() });
export type ScheduleIdentityOptions = z.infer<typeof ScheduleIdentityOptions>;

/** GET /api/schedules/delivery-options: configured recipient lists and Teams webhooks (names, never values). */
export const DeliveryOptionsResponse = z.object({
  email: z.object({ available: z.boolean(), lists: z.array(DeliveryList) }),
  teams: z.object({ lists: z.array(DeliveryList) }),
  /** Absent from an older API = the automation identity only. */
  identities: ScheduleIdentityOptions.optional(),
});
export type DeliveryOptionsResponse = z.infer<typeof DeliveryOptionsResponse>;

/** Names of configuration keys (AF_…); whether one may be used is checked against the configuration. */
const ConfigKey = z
  .string()
  .regex(/^AF_[A-Z0-9_]{1,100}$/, 'Expected a configuration key like AF_REPORT_RECIPIENTS');

/** POST /api/schedules, PUT /api/schedules/:key — a report schedule created in the portal. */
export const PortalScheduleRequest = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).optional(),
  cron: z.string().trim().min(1).max(100),
  timezone: TimeZone,
  enabled: z.boolean().default(true),
  /**
   * Who it runs as (ADR-014): the automation identity, a configured app identity, or `{ user: creator }` — the
   * creator's own read access, granted once through POST /auth/schedule-consent.
   */
  identity: ScheduleIdentity.default('automation'),
  job: z.object({
    /** Only report jobs can be created in the portal; every other kind is content. */
    kind: z.literal('report'),
    ref: DefinitionId,
    params: z.record(z.string(), z.unknown()).optional(),
    format: z.enum(['xlsx', 'csv', 'json']),
    /** Keep the newest N files. */
    retain: z.number().int().min(1).max(1000).default(26),
    /** A configured recipient list (AF_…_RECIPIENTS / _EMAIL / _ALERTS). */
    emailKey: ConfigKey.optional(),
    /** A configured Teams webhook (AF_…_WEBHOOK). */
    teamsKey: ConfigKey.optional(),
  }),
  notifyOnFailure: z.object({ emailKey: ConfigKey.optional(), teamsKey: ConfigKey.optional() }).optional(),
});
export type PortalScheduleRequest = z.infer<typeof PortalScheduleRequest>;
