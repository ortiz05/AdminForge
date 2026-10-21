import { z } from 'zod';
import { Expr, Identifier, exprOr } from './common';
import { patternProblem } from './regex-safety';

/**
 * Page params and playbook inputs share one schema (§7.3, §7.7).
 * - Page params are optional unless `required: true`; they map to the URL and the filter bar.
 * - Playbook/runbook inputs are required unless `required: false` or a `default` is given; they generate the run form.
 * - `facet: true` shows the param as a facet chip in the filter bar; `hidden: true` keeps it out of the UI (e.g. an entity id).
 */

export const ENTITY_KINDS = ['user', 'group', 'device', 'app', 'resource', 'subscription'] as const;
export const EntityKind = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKind>;

const base = {
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  facet: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /** Redacted in audit records and run views. */
  redact: z.boolean().optional(),
};

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const Guid = z.string().regex(GUID_RE, 'Expected a GUID');
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Expected an ISO date like 2026-01-31');
/** Relative date: `today`, `now`, `-30d`, `+7d`, `-12h`. */
const RelativeDate = z
  .string()
  .regex(/^(today|now|[+-]\d+[hdwmy])$/, 'Expected today, now, or an offset like -30d');

export const StringParam = z.strictObject({
  type: z.literal('string'),
  ...base,
  default: z.string().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  /**
   * Regular expression the whole value must match (anchored as `^(?:…)$`, `u` flag). Nested repetition and
   * backreferences are refused: a pattern runs synchronously on the API's event loop (regex-safety.ts).
   */
  pattern: z
    .string()
    .superRefine((source, ctx) => {
      const problem = patternProblem(source);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .optional(),
  multiline: z.boolean().optional(),
  format: z.enum(['guid', 'email', 'upn', 'url', 'hostname']).optional(),
  /** Search-as-you-type entity picker that fills this string (usually the object id). */
  picker: EntityKind.optional(),
});

export const NumberParam = z.strictObject({
  type: z.literal('number'),
  ...base,
  default: exprOr(z.number()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  integer: z.boolean().optional(),
  unit: z.string().optional(),
});

export const BooleanParam = z.strictObject({
  type: z.literal('boolean'),
  ...base,
  default: exprOr(z.boolean()).optional(),
});

const EnumValue = z.union([z.string(), z.number(), z.boolean()]);
export const EnumOption = z.union([
  EnumValue,
  z.strictObject({ value: EnumValue, label: z.string().min(1), icon: z.string().optional() }),
]);

export const EnumParam = z.strictObject({
  type: z.literal('enum'),
  ...base,
  values: z.array(EnumOption).min(1),
  /** Multi-select (the value becomes an array). */
  multiple: z.boolean().optional(),
  default: z.union([EnumValue, z.array(EnumValue)]).optional(),
});

export const DateParam = z.strictObject({
  type: z.literal('date'),
  ...base,
  default: z.union([IsoDate, RelativeDate, Expr]).optional(),
  min: z.union([IsoDate, RelativeDate]).optional(),
  max: z.union([IsoDate, RelativeDate]).optional(),
  /** Include a time picker. */
  time: z.boolean().optional(),
});

/** Value is `{ from, to }` (ISO strings) plus the ISO 8601 `timespan` used by Log Analytics. */
export const DateRangeParam = z.strictObject({
  type: z.literal('dateRange'),
  ...base,
  /** Preset ISO durations offered in the picker, e.g. [PT1H, P1D, P7D, P30D]. */
  presets: z.array(z.string().regex(/^P/)).optional(),
  default: z
    .union([
      z.string().regex(/^P/, 'Expected an ISO duration like P7D'),
      z.strictObject({ from: z.string(), to: z.string() }),
    ])
    .optional(),
  /** Longest range allowed, as an ISO duration. */
  max: z.string().regex(/^P/).optional(),
});

export const GuidParam = z.strictObject({
  type: z.literal('guid'),
  ...base,
  default: z.union([Guid, Expr]).optional(),
});

const entityParam = <K extends (typeof ENTITY_KINDS)[number]>(kind: K) =>
  z.strictObject({
    type: z.literal(kind),
    ...base,
    multiple: z.boolean().optional(),
    /** Max selections when `multiple` (bulk inputs). */
    maxItems: z.number().int().min(1).max(1000).optional(),
    default: z.union([z.string(), z.array(z.string())]).optional(),
    /** Narrows the picker, e.g. OData filter for users/groups or resource types for resources. */
    filter: z.string().optional(),
    resourceTypes: z.array(z.string()).optional(),
  });

export const Param = z.discriminatedUnion('type', [
  StringParam,
  NumberParam,
  BooleanParam,
  EnumParam,
  DateParam,
  DateRangeParam,
  GuidParam,
  entityParam('user'),
  entityParam('group'),
  entityParam('device'),
  entityParam('app'),
  entityParam('resource'),
  entityParam('subscription'),
]);
export type Param = z.infer<typeof Param>;
export type ParamType = Param['type'];

export const Params = z.record(Identifier, Param);
export type Params = z.infer<typeof Params>;
