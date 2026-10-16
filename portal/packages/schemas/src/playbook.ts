import { z } from 'zod';
import { PortalRole } from './api';
import {
  DefinitionId,
  Duration,
  Expr,
  HttpMethod,
  Identifier,
  Mode,
  NavPlacement,
  RetryPolicy,
  SemVer,
  Template,
  envelopeShape,
  exprOr,
} from './common';
import {
  ArmRequestSpec,
  FunctionCallSpec,
  GraphRequestSpec,
  LogAnalyticsSpec,
  ResourceGraphSpec,
  RunnerSpec,
} from './datasource';
import { Params } from './params';

/**
 * Playbooks and runbooks (§7.7) and the engine-facing step union (§7.8).
 * Expression scope inside steps: `inputs`, `steps.<id>.output`, `run`, `user`, `env`, `now`, plus `item` (or the
 * `forEach.as` name) inside a forEach. Steps default to `mode: read`; dry runs execute read steps and plan write steps
 * (output = `dryRunOutput`, else null).
 */

export const OnError = z.enum(['fail', 'continue', 'compensate']);

/**
 * A path into a step's output naming a secret field: dot-separated keys, `*` for every key/element, digits for an
 * array index — e.g. `temporaryAccessPass`, `newPassword`, `responses.*.secretText`.
 */
export const SecretPath = z
  .string()
  .regex(
    /^(\*|[A-Za-z_$][\w$]*)(\.(\*|[A-Za-z_$][\w$]*|\d+))*$/,
    'Use a dot path into the output, e.g. temporaryAccessPass or credentials.*.secretText',
  );

/** Absolute https URL whose host is literal, so validate/engine can check it against the http allowlist. */
const HttpUrl = z
  .string()
  .regex(
    /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/|$)/,
    'http steps need an absolute https:// URL with a literal host (checked against the allowlist)',
  );

export const HttpRequestSpec = z.strictObject({
  method: HttpMethod.default('GET'),
  url: HttpUrl,
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

const NotifyTarget = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** Bodies of steps that call something. Shared by steps and `compensate` blocks. */
const actionBodies = {
  graph: {
    request: GraphRequestSpec,
    paging: z.enum(['none', 'all']).optional(),
    maxItems: z.number().int().min(1).max(100_000).optional(),
  },
  graphBatch: { requests: z.record(Identifier, GraphRequestSpec) },
  arm: {
    request: ArmRequestSpec,
    paging: z.enum(['none', 'all']).optional(),
    /** Wait for long-running operations (Azure-AsyncOperation / Location). Default true. */
    poll: z.boolean().optional(),
    pollTimeout: Duration.optional(),
  },
  resourceGraph: { ...ResourceGraphSpec, paging: z.enum(['none', 'all']).optional() },
  logAnalytics: LogAnalyticsSpec,
  function: FunctionCallSpec,
  runner: RunnerSpec,
  http: { request: HttpRequestSpec },
  /** Teams chat/channel message or email via Graph, sent as the user (a write: needs `mode: write`). */
  notify: {
    channel: z.enum(['email', 'teamsChat', 'teamsChannel']),
    /** email: addresses; teamsChat: user ids/UPNs or a chat id; teamsChannel: `<teamId>/<channelId>`. */
    to: NotifyTarget,
    subject: Template.optional(),
    /** Markdown (converted to HTML for email/Teams). */
    message: Template,
  },
  playbook: {
    ref: DefinitionId,
    /** Exact version to pin (default: the published version). */
    version: SemVer.optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  },
} as const;

type ActionType = keyof typeof actionBodies;
export const ACTION_STEP_TYPES = Object.keys(actionBodies) as ActionType[];

/** A compensating action, run in reverse order when a later step fails with `onError: compensate`. Always a write. */
export const Compensation = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('graph'),
    describe: Template.optional(),
    retry: RetryPolicy.optional(),
    ...actionBodies.graph,
  }),
  z.strictObject({
    type: z.literal('graphBatch'),
    describe: Template.optional(),
    retry: RetryPolicy.optional(),
    ...actionBodies.graphBatch,
  }),
  z.strictObject({
    type: z.literal('arm'),
    describe: Template.optional(),
    retry: RetryPolicy.optional(),
    ...actionBodies.arm,
  }),
  z.strictObject({
    type: z.literal('function'),
    describe: Template.optional(),
    retry: RetryPolicy.optional(),
    ...actionBodies.function,
  }),
  z.strictObject({
    type: z.literal('runner'),
    describe: Template.optional(),
    retry: RetryPolicy.optional(),
    ...actionBodies.runner,
  }),
  z.strictObject({
    type: z.literal('http'),
    describe: Template.optional(),
    retry: RetryPolicy.optional(),
    ...actionBodies.http,
  }),
  z.strictObject({
    type: z.literal('playbook'),
    describe: Template.optional(),
    retry: RetryPolicy.optional(),
    ...actionBodies.playbook,
  }),
]);
export type Compensation = z.infer<typeof Compensation>;

const stepBase = {
  /** Referenced as `steps.<id>.output`, so it must be an identifier. Unique within the definition. */
  id: Identifier,
  /** Short label for the run timeline (defaults to `describe` or the id). */
  name: z.string().optional(),
  /** What the step does, in plain words; required for write steps (shown in the dry-run plan). */
  describe: Template.optional(),
  mode: Mode.optional(),
  /** Skip the step unless true. */
  when: exprOr(z.boolean()).optional(),
  retry: RetryPolicy.optional(),
  onError: OnError.optional(),
  compensate: Compensation.optional(),
  /** false → a crash while in flight marks the step `needs_review` instead of retrying (§7.8). Default true. */
  idempotent: z.boolean().optional(),
  /** Output used for this step in dry runs when it is a write (templated). */
  dryRunOutput: z.unknown().optional(),
  /**
   * Show-once secrets in this step's output (passwords, Temporary Access Passes, client secrets). The values are shown
   * once to the person who started the run and replaced by `{ $secret: true, hint }` everywhere else — stored step
   * output, run outputs, events, audit, and the expression scope of later steps (which may not reference them).
   */
  secretOutputs: z.array(SecretPath).min(1).optional(),
  /** The whole output is a show-once secret (see secretOutputs). */
  secret: z.boolean().optional(),
  timeout: Duration.optional(),
};

export const GraphStep = z.strictObject({ ...stepBase, type: z.literal('graph'), ...actionBodies.graph });
export const GraphBatchStep = z.strictObject({
  ...stepBase,
  type: z.literal('graphBatch'),
  ...actionBodies.graphBatch,
});
export const ArmStep = z.strictObject({ ...stepBase, type: z.literal('arm'), ...actionBodies.arm });
export const ResourceGraphStep = z.strictObject({
  ...stepBase,
  type: z.literal('resourceGraph'),
  ...actionBodies.resourceGraph,
});
export const LogAnalyticsStep = z.strictObject({
  ...stepBase,
  type: z.literal('logAnalytics'),
  ...actionBodies.logAnalytics,
});
export const FunctionStep = z.strictObject({
  ...stepBase,
  type: z.literal('function'),
  ...actionBodies.function,
});
export const RunnerStep = z.strictObject({ ...stepBase, type: z.literal('runner'), ...actionBodies.runner });
export const HttpStep = z.strictObject({ ...stepBase, type: z.literal('http'), ...actionBodies.http });
export const NotifyStep = z.strictObject({ ...stepBase, type: z.literal('notify'), ...actionBodies.notify });
export const PlaybookStep = z.strictObject({
  ...stepBase,
  type: z.literal('playbook'),
  ...actionBodies.playbook,
});

/** Output = the expression's value. */
export const TransformStep = z.strictObject({ ...stepBase, type: z.literal('transform'), expression: Expr });

/** Fails the run (status failed, failedStep = this id) unless `that` is true. */
export const AssertStep = z.strictObject({
  ...stepBase,
  type: z.literal('assert'),
  that: Expr,
  message: Template,
});

/** Default `expiresIn` of an approval gate that sets none: an unanswered request expires and fails the run. */
export const DEFAULT_APPROVAL_EXPIRES_IN = 'P3D';

/**
 * Who may not approve a gate because the change benefits them: an expression yielding one object id or a list of
 * them (users being added to a group, the principal getting a role and the members of a group getting one). It is
 * evaluated when the gate opens; the API refuses a decision by anyone listed (403 `own_access`), on top of the rule
 * that nobody approves a run they started.
 */
const ApprovalExcludes = Expr.meta({
  description:
    'Object ids that may not decide on this approval because the change grants them access (evaluated when the gate opens; a ${ … } expression yielding an id or a list of ids).',
});

/** Parks the run in `awaiting_approval`; later steps run as the approver (§7.8). */
export const ApprovalStep = z.strictObject({
  ...stepBase,
  type: z.literal('approval'),
  message: Template.optional(),
  approvers: z.array(PortalRole).optional(),
  minApprovals: z.number().int().min(1).max(5).optional(),
  /** How long the request stays open (default P3D = 72 hours); an expired request fails the run. */
  expiresIn: Duration.optional(),
  excludes: ApprovalExcludes.optional(),
});

/** A checklist item a human confirms (runbooks), optionally collecting inputs. */
export const ManualStep = z.strictObject({
  ...stepBase,
  type: z.literal('manual'),
  /** Markdown. */
  instructions: Template,
  checklist: z.array(Template).optional(),
  inputs: Params.optional(),
});

export const WaitStep = z
  .strictObject({
    ...stepBase,
    type: z.literal('wait'),
    duration: Duration.optional(),
    until: Expr.optional(),
    /** Poll interval for `until` (default 30s). */
    interval: Duration.optional(),
  })
  .refine((s) => !!s.duration !== !!s.until, {
    message: 'A wait step needs exactly one of duration or until',
    path: ['duration'],
  });

const branchHead = { ...stepBase, type: z.literal('branch'), if: Expr };
const forEachHead = {
  ...stepBase,
  type: z.literal('forEach'),
  /** Expression returning the array to iterate (≤ 1000 items). */
  items: Expr,
  /** Scope name for the current item (default `item`); `index` is also in scope. */
  as: Identifier.optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  maxItems: z.number().int().min(1).max(1000).optional(),
};
const BranchHead = z.strictObject(branchHead);
const ForEachHead = z.strictObject(forEachHead);

const leafSteps = [
  GraphStep,
  GraphBatchStep,
  ArmStep,
  ResourceGraphStep,
  LogAnalyticsStep,
  FunctionStep,
  RunnerStep,
  HttpStep,
  TransformStep,
  AssertStep,
  ApprovalStep,
  ManualStep,
  WaitStep,
  NotifyStep,
  PlaybookStep,
] as const;
type LeafStep = z.infer<(typeof leafSteps)[number]>;

/** `if` true → `then`, else `else`. */
export interface BranchStep extends z.infer<typeof BranchHead> {
  then: Step[];
  else?: Step[] | undefined;
}
/** Runs `steps` for every item (concurrency ≤ 10, items ≤ 1000). */
export interface ForEachStep extends z.infer<typeof ForEachHead> {
  steps: Step[];
}
export type Step = LeafStep | BranchStep | ForEachStep;

const lazyStep = z.lazy((): z.ZodType<Step> => Step);

export const BranchStep = BranchHead.extend({
  then: z.array(lazyStep).min(1),
  else: z.array(lazyStep).optional(),
});
export const ForEachStep = ForEachHead.extend({ steps: z.array(lazyStep).min(1) });

export const Step: z.ZodType<Step> = z.discriminatedUnion('type', [...leafSteps, BranchStep, ForEachStep]);
export type StepType = Step['type'];

export const RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const Risk = z.enum(RISKS);
export type Risk = z.infer<typeof Risk>;

export const Confirm = z
  .strictObject({
    type: z.enum(['none', 'click', 'typed']),
    /** typed: the text the user must type (templated, e.g. the target UPN). */
    value: Template.optional(),
    message: Template.optional(),
  })
  .refine((c) => c.type !== 'typed' || !!c.value, {
    message: 'Typed confirmation needs a value',
    path: ['value'],
  });
export type Confirm = z.infer<typeof Confirm>;

/**
 * `required: true` adds an implicit approval gate before the first write step. `approvers`, `minApprovals`,
 * `expiresIn` and `excludes` also apply to explicit approval steps that don't set their own.
 */
export const Approval = z.strictObject({
  required: z.boolean(),
  approvers: z.array(PortalRole).optional(),
  minApprovals: z.number().int().min(1).max(5).optional(),
  /** How long the request stays open (default P3D = 72 hours); an expired request fails the run. */
  expiresIn: Duration.optional(),
  excludes: ApprovalExcludes.optional(),
});
export type Approval = z.infer<typeof Approval>;

const RUN_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'compensated',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_arm',
  'awaiting_reauth',
] as const;
export const RunStatus = z.enum(RUN_STATUSES);

/** Dry-run test with mocked step outputs, run by `adminforge test`. */
export const PlaybookTest = z.strictObject({
  name: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).optional(),
  /** Step id → output used instead of calling the service. */
  mocks: z.record(z.string(), z.unknown()).optional(),
  /** Step id → simulated failure. */
  errors: z
    .record(
      z.string(),
      z.strictObject({
        status: z.number().int().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
  /** Defaults to true (write steps are planned, not executed). */
  dryRun: z.boolean().optional(),
  /** Virtual "now" for this test (ISO date-time), e.g. to test expiry windows. */
  now: z.iso.datetime({ offset: true }).optional(),
  /** `${ env.X }` values for this test (configuration such as AF_READ_CLIENT_ID), merged over the runner's env. */
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).optional(),
  user: z
    .strictObject({
      oid: z.string().optional(),
      upn: z.string().optional(),
      roles: z.array(z.string()).optional(),
    })
    .optional(),
  expect: z.strictObject({
    status: RunStatus,
    failedStep: z.string().optional(),
    outputs: z.record(z.string(), z.unknown()).optional(),
    /** Ids of write steps expected in the dry-run plan, in order. */
    plan: z.array(z.string()).optional(),
    /** Step id → expected status. */
    steps: z
      .record(z.string(), z.enum(['succeeded', 'failed', 'skipped', 'planned', 'compensated']))
      .optional(),
  }),
});
export type PlaybookTest = z.infer<typeof PlaybookTest>;

const automationShape = {
  ...envelopeShape,
  nav: NavPlacement.optional(),
  risk: Risk,
  mode: Mode,
  confirm: Confirm.optional(),
  approval: Approval.optional(),
  inputs: Params.optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  tests: z.array(PlaybookTest).optional(),
  /** Max run time (≤ 4h, §7.8). */
  timeout: Duration.optional(),
  /**
   * The playbook changes the initiator's own permissions (e.g. PIM activation): when an interactive run succeeds, the
   * initiator's delegated tokens are refreshed so the new Entra roles apply right away instead of at token expiry.
   */
  refreshTokens: z.boolean().optional(),
};

/** Calls `visit` for every step, depth-first, including steps nested in branch/forEach. */
export function walkSteps(
  steps: readonly Step[],
  visit: (step: Step, path: (string | number)[]) => void,
  path: (string | number)[] = ['steps'],
): void {
  steps.forEach((step, i) => {
    const here = [...path, i];
    visit(step, here);
    if (step.type === 'branch') {
      walkSteps(step.then, visit, [...here, 'then']);
      if (step.else) walkSteps(step.else, visit, [...here, 'else']);
    } else if (step.type === 'forEach') walkSteps(step.steps, visit, [...here, 'steps']);
  });
}

/** Effective mode of a step (default read). */
export const stepMode = (step: Step): Mode => step.mode ?? 'read';

const requestMethod = (step: Step): string | undefined =>
  step.type === 'graph' || step.type === 'arm' || step.type === 'http' ? step.request.method : undefined;

const STEP_OUTPUT_REF =
  /steps\.([A-Za-z_][A-Za-z0-9_]*)\.output((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\.\s*\d+|\[\s*\d+\s*\])*)/g;
const LOOKUP_REF = /\$lookup\(\s*steps\.([A-Za-z_][A-Za-z0-9_]*)\.output\s*,\s*["']([^"']+)["']/g;

/** Output path segments referenced after `steps.<id>.output` (`.a.b`, `[0]`). */
const refSegments = (tail: string) =>
  [...tail.matchAll(/\.\s*([A-Za-z_$][\w$]*|\d+)|\[\s*(\d+)\s*\]/g)].map((m) => m[1] ?? m[2]!);

/** True when a reference to `ref` (segments under the output) can read the secret at `secret`. */
function readsSecret(ref: string[], secret: string[]): boolean {
  if (ref.length < secret.length) return false;
  return secret.every((seg, i) => seg === '*' || seg === ref[i]);
}

/**
 * Show-once secrets may not flow anywhere: no expression (later steps, outputs, confirm, compensations…) may read a
 * declared secret path, or any part of an output declared `secret: true`. The engine also masks them at run time.
 */
function checkSecrets(
  def: Record<string, unknown>,
  groups: Array<{ steps: readonly Step[]; path: (string | number)[] }>,
  ctx: z.RefinementCtx,
): void {
  const secrets = new Map<string, string[][]>();
  for (const { steps } of groups)
    walkSteps(steps, (step) => {
      const paths = [...(step.secret ? [[]] : []), ...(step.secretOutputs ?? []).map((p) => p.split('.'))];
      if (paths.length) secrets.set(step.id, paths);
    });
  if (!secrets.size) return;
  const visit = (value: unknown, at: (string | number)[]) => {
    if (typeof value === 'string') {
      if (!value.includes('${')) return;
      const hits: Array<[string, string[]]> = [];
      for (const m of value.matchAll(STEP_OUTPUT_REF)) hits.push([m[1]!, refSegments(m[2] ?? '')]);
      for (const m of value.matchAll(LOOKUP_REF)) hits.push([m[1]!, m[2]!.split('.')]);
      for (const [id, ref] of hits) {
        const bad = secrets.get(id)?.find((secret) => readsSecret(ref, secret));
        if (bad)
          ctx.addIssue({
            code: 'custom',
            path: at,
            message: `steps.${id}.output${bad.length ? `.${bad.join('.')}` : ''} is a show-once secret; it is shown to the person who ran the playbook and cannot be used in expressions or outputs.`,
          });
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, [...at, i]));
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value))
        if (!(at.length === 0 && k === 'tests')) visit(v, [...at, k]);
  };
  visit(def, []);
}

function checkAutomation(
  def: { mode: Mode; risk: Risk; confirm?: Confirm; approval?: Approval; tests?: PlaybookTest[] },
  groups: Array<{ steps: readonly Step[]; path: (string | number)[] }>,
  ctx: z.RefinementCtx,
): void {
  checkSecrets(def as unknown as Record<string, unknown>, groups, ctx);
  const ids = new Map<string, string>();
  for (const { steps, path } of groups) {
    walkSteps(
      steps,
      (step, at) => {
        const where = at.join('.');
        if (ids.has(step.id))
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'id'],
            message: `Duplicate step id "${step.id}" (also at ${ids.get(step.id)}).`,
          });
        else ids.set(step.id, where);
        const mode = stepMode(step);
        const method = requestMethod(step);
        if (method && ['PUT', 'PATCH', 'DELETE'].includes(method) && mode !== 'write')
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'mode'],
            message: `${method} changes data: declare mode: write.`,
          });
        if (method === 'POST' && !step.mode)
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'mode'],
            message: 'POST requests must declare mode: read or mode: write explicitly.',
          });
        if (step.type === 'notify' && mode !== 'write')
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'mode'],
            message: 'notify sends a message as the user: declare mode: write.',
          });
        if (mode === 'write' && def.mode !== 'write')
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'mode'],
            message: 'Write step in a read-only definition: set the top-level mode: write.',
          });
        if (mode === 'write' && !step.describe)
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'describe'],
            message: 'Write steps need describe (shown in the dry-run plan).',
          });
        if (step.onError === 'compensate' && def.mode !== 'write')
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'onError'],
            message: 'Compensation only applies to write definitions.',
          });
      },
      path,
    );
  }
  if ((def.risk === 'high' || def.risk === 'critical') && (!def.confirm || def.confirm.type === 'none'))
    ctx.addIssue({
      code: 'custom',
      path: ['confirm'],
      message: `risk: ${def.risk} needs a confirm block (click or typed).`,
    });
  if (def.risk === 'critical' && !def.approval?.required)
    ctx.addIssue({
      code: 'custom',
      path: ['approval'],
      message: 'risk: critical needs approval: { required: true }.',
    });
  def.tests?.forEach((t, i) => {
    for (const key of [...Object.keys(t.mocks ?? {}), ...Object.keys(t.errors ?? {})])
      if (!ids.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['tests', i, t.mocks && key in t.mocks ? 'mocks' : 'errors', key],
          message: `Unknown step id "${key}".`,
        });
    for (const key of [t.expect.failedStep, ...(t.expect.plan ?? []), ...Object.keys(t.expect.steps ?? {})])
      if (key && !ids.has(key))
        ctx.addIssue({ code: 'custom', path: ['tests', i, 'expect'], message: `Unknown step id "${key}".` });
  });
}

export const Playbook = z
  .strictObject({
    kind: z.literal('playbook'),
    ...automationShape,
    steps: z.array(Step).min(1),
  })
  .superRefine((def, ctx) => checkAutomation(def, [{ steps: def.steps, path: ['steps'] }], ctx));
export type Playbook = z.infer<typeof Playbook>;

/** Runbook section: Markdown interleaved with steps (manual checklists, embedded steps, child playbooks). */
export const RunbookSection = z.strictObject({
  id: Identifier,
  title: z.string().min(1),
  /** Markdown (templated). */
  body: Template.optional(),
  steps: z.array(Step).optional(),
});
export type RunbookSection = z.infer<typeof RunbookSection>;

export const Runbook = z
  .strictObject({
    kind: z.literal('runbook'),
    ...automationShape,
    sections: z.array(RunbookSection).min(1),
  })
  .superRefine((def, ctx) =>
    checkAutomation(
      def,
      def.sections.map((s, i) => ({ steps: s.steps ?? [], path: ['sections', i, 'steps'] })),
      ctx,
    ),
  );
export type Runbook = z.infer<typeof Runbook>;

/** Top-level steps in execution order (runbook sections are concatenated). */
export function flattenSteps(def: Playbook | Runbook): Step[] {
  return def.kind === 'playbook' ? def.steps : def.sections.flatMap((s) => s.steps ?? []);
}
