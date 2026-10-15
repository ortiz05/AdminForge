import { ApiError } from '@adminforge/connectors';
import type { PlaybookTest } from '@adminforge/schemas';
import { VirtualClock } from './clock';
import { Engine } from './engine';
import { StepError } from './errors';
import { validateInputs } from './inputs';
import { MemoryRunStore } from './memory-store';
import type { ChildRunner, IdentityResolver, OutboundPort, RunnerPort } from './ports';
import type { Actor, AutomationDefinition, PlanEntry, RunError, RunStatus, StepStatus } from './types';

/**
 * Content tests (§7.9 step 4): runs each `tests:` block of a playbook/runbook in a sandbox — dry run by default,
 * `mocks` replace step outputs, `errors` simulate failures (ApiError with the given status), nothing reaches a
 * service — and checks `expect`. Used by `adminforge test` and tests/content.
 *
 * - A read step without a mock fails with `no_mock` (tests must say what the service returns).
 * - In dry-run tests an unmocked write `type: playbook` step is planned as one entry (output = dryRunOutput, else
 *   null); a mocked one counts as a child that ran (succeeded, not in the plan — its own tests cover its plan).
 *   Non-dry tests run unmocked children through `resolveChild`.
 * - `expect.plan` lists the ids of planned writes in order (compensation entries are excluded; check them with
 *   `expect.steps: { <id>: compensated }`).
 * - `expect.steps` compares the latest status recorded for each step id.
 * - `wait` steps are fast-forwarded on a virtual clock; approvals/manual steps leave the run parked.
 */

export interface PlaybookTestResult {
  name: string;
  passed: boolean;
  failures: string[];
  status: RunStatus;
  error: RunError | null;
  outputs: Record<string, unknown> | null;
  plan: PlanEntry[];
  steps: Record<string, StepStatus>;
  /** Show-once secrets the run produced (field names only; values are never kept). */
  secrets: Array<{ stepPath: string; fields: string[] }>;
}

export interface RunTestsOptions {
  /** Virtual "now" for the run (default 2026-01-15T12:00:00Z). */
  now?: Date | string;
  env?: Record<string, unknown>;
  /** Resolves child playbooks for nested dry runs; without it `type: playbook` steps need a mock. */
  resolveChild?: (ref: string, version?: string) => Promise<AutomationDefinition | null> | AutomationDefinition | null;
}

const TEST_USER: Actor = { kind: 'delegated', oid: '00000000-0000-4000-8000-00000000c0de', upn: 'tester@example.com' };

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 200 ? `${s.slice(0, 197)}…` : s;
};

const noMock = (what: string) =>
  new StepError('no_mock', `No mock for ${what}. Add the step id under mocks: in this test (tests never call services).`);

export async function runPlaybookTest(def: AutomationDefinition, test: PlaybookTest, index = 0, opts: RunTestsOptions = {}): Promise<PlaybookTestResult> {
  const clock = new VirtualClock(opts.now ?? '2026-01-15T12:00:00.000Z');
  const store = new MemoryRunStore(clock.now);
  const base = { name: test.name, plan: [] as PlanEntry[], steps: {} as Record<string, StepStatus>, outputs: null, error: null, secrets: [] };
  const secrets: PlaybookTestResult['secrets'] = [];

  const validated = await validateInputs(def.inputs, test.inputs ?? {}, { now: clock.now(), env: opts.env ?? {} });
  if (!validated.ok) {
    return { ...base, passed: false, status: 'failed', failures: validated.errors.map((e) => `inputs.${e.field}: ${e.message}`) };
  }
  const initiator: Actor = { kind: 'delegated', oid: test.user?.oid ?? TEST_USER.oid, upn: test.user?.upn ?? TEST_USER.upn };
  const roles = test.user?.roles ?? ['Portal.Reader', 'Portal.Operator'];
  // Run ids are UUIDs in production (content may use `$guid(run.id)`).
  const runId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  store.create({ id: runId, kind: def.kind, definitionKey: def.id, definitionVersion: def.version, dryRun: test.dryRun ?? true, inputs: validated.values, initiator, startedAt: null });

  const mocks = test.mocks ?? {};
  const errors = test.errors ?? {};
  const outbound: OutboundPort = {
    async call(_identity, call) {
      if (call.declaredWrite) return { data: null };
      throw noMock(`${call.service} ${call.method} ${call.path}`);
    },
  };
  const runner: RunnerPort = {
    async run(_identity, job) {
      if (job.mode === 'write') return { status: 'succeeded', output: null };
      throw noMock(`script ${job.script}`);
    },
  };
  const identity: IdentityResolver = { resolve: async (_run, actor, mode) => ({ actor, mode, handle: null }) };

  const holder: { engine?: Engine } = {};
  const children: ChildRunner = {
    async run(req) {
      const child = opts.resolveChild ? await opts.resolveChild(req.ref, req.version) : null;
      if (!child) throw noMock(`child playbook ${req.ref}`);
      const v = await validateInputs(child.inputs, req.inputs, { now: clock.now(), env: opts.env ?? {} });
      if (!v.ok) throw new StepError('invalid_inputs', `Child playbook ${req.ref}: ${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
      const childId = `${req.parent.id}>${req.path}`;
      if (!store.runs.has(childId))
        store.create({ id: childId, kind: child.kind, definitionKey: child.id, definitionVersion: child.version, dryRun: req.dryRun, inputs: v.values, initiator: req.actor, parentRunId: req.parent.id, trigger: 'child' });
      const out = await holder.engine!.execute(childId, child, { depth: req.depth, signal: req.signal });
      const plan = (await store.listSteps(childId)).flatMap((r) => r.plan ?? []);
      return { runId: childId, status: out.status, outputs: out.outputs ?? null, error: out.error ?? null, plan, ...(out.wakeAt ? { wakeAt: out.wakeAt } : {}) };
    },
  };

  const engine = (holder.engine = new Engine({
    store,
    clock,
    identity,
    outbound,
    runner,
    children,
    env: opts.env ?? {},
    rolesOf: () => roles,
    // Dry-run tests plan child playbooks like any other write (mock them to give them an output);
    // non-dry tests run them through resolveChild.
    dryRunChildren: false,
    notifier: { send: async () => ({}) },
    secrets: { deliver: async (_run, s) => (secrets.push({ stepPath: s.stepPath, fields: Object.keys(s.values) }), { status: 'delivered' }) },
    intercept: (step, _path, info) => {
      if (info.runId !== runId || info.compensation) return undefined;
      const e = errors[step.id];
      if (e) return { error: new ApiError(e.status ?? 500, e.code ?? 'SimulatedError', e.message ?? `Simulated ${e.status ?? 500} from the test.`) };
      if (Object.hasOwn(mocks, step.id)) return { output: mocks[step.id] };
      return undefined;
    },
  }));

  let outcome = await engine.execute(runId, def);
  for (let n = 0; outcome.status === 'running' && outcome.wakeAt && n < 1000; n++) {
    clock.set(outcome.wakeAt);
    outcome = await engine.execute(runId, def);
  }

  const run = (await store.getRun(runId))!;
  const records = await store.listSteps(runId);
  const plan = records.flatMap((r) => r.plan ?? []);
  const steps: Record<string, StepStatus> = {};
  for (const r of records) if (!r.path.includes('#') && !r.path.includes('>')) steps[r.stepId] = r.status;

  const failures: string[] = [];
  const exp = test.expect;
  const why = run.error ? ` (${run.error.stepId ?? 'run'}: ${run.error.code} — ${run.error.message})` : '';
  if (run.status !== exp.status) failures.push(`status: expected ${exp.status}, got ${run.status}${why}`);
  if (exp.failedStep !== undefined && run.error?.stepId !== exp.failedStep) failures.push(`failedStep: expected ${exp.failedStep}, got ${run.error?.stepId ?? 'none'}${why}`);
  if (exp.plan) {
    const ids = plan.filter((e) => !e.compensation && !e.childRunId).map((e) => e.stepId);
    if (!deepEqual(ids, exp.plan)) failures.push(`plan: expected [${exp.plan.join(', ')}], got [${ids.join(', ')}]`);
  }
  for (const [key, want] of Object.entries(exp.outputs ?? {})) {
    const got = run.outputs?.[key];
    if (!deepEqual(got, want)) failures.push(`outputs.${key}: expected ${show(want)}, got ${show(got)}`);
  }
  for (const [id, want] of Object.entries(exp.steps ?? {})) {
    if (steps[id] !== want) failures.push(`steps.${id}: expected ${want}, got ${steps[id] ?? 'not run'}`);
  }
  return { name: test.name, passed: failures.length === 0, failures, status: run.status, error: run.error, outputs: run.outputs, plan, steps, secrets };
}

/** Runs every `tests:` block of the definition. */
export async function runPlaybookTests(def: AutomationDefinition, opts: RunTestsOptions = {}): Promise<PlaybookTestResult[]> {
  const out: PlaybookTestResult[] = [];
  for (const [i, t] of (def.tests ?? []).entries()) out.push(await runPlaybookTest(def, t, i, opts));
  return out;
}
