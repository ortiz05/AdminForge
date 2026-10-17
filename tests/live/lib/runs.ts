import { PARKED_RUN_STATUSES, TERMINAL_RUN_STATUSES } from '@adminforge/engine';
import type { ApiCall } from './portal-session';

/**
 * Playbook runs through the portal API as the signed-in validation user, the way the playbook drawer does it:
 * preview (a dry run with the same inputs) → the real run with `previewRunId` (and, for a typed confirm, the text the
 * UI would ask for, read from the preview's step outputs) → poll until the run settles.
 *
 * One rule for "settled", shared by the scripts and the live suite: a terminal status (succeeded, failed, cancelled,
 * compensated, needs_review) or a parked one (awaiting_approval, awaiting_input, awaiting_arm, awaiting_reauth) — the
 * engine's own lists. Previews are retried while they fail: Graph is eventually consistent, so a preview right after
 * a write may still see the old state.
 *
 * Inputs: an `ApiCall` (lib/portal-session.ts) and optionally `sleep` (the live spec passes `page.waitForTimeout`).
 * Outputs: run details (status, error, steps, plan); nothing is printed here — callers print statuses and
 * `why(run.error)` (lib/mask.ts). Safety: a real run is only created with the id of a succeeded preview; whether it
 * may write is the server's decision (armed session, confirm, approval).
 * Used by scripts/run-playbook.ts and e2e/portal.live.spec.ts; tested in tests/unit/live/runs.test.ts.
 */

export interface RunError {
  code?: string;
  message?: string;
}

export interface RunStep {
  stepId: string;
  type?: string;
  mode?: string;
  status: string;
  output?: Record<string, unknown>;
  error?: RunError;
}

/** GET /api/runs/:id (the fields live checks read). */
export interface RunDetail {
  run: { status: string; error?: RunError };
  steps: RunStep[];
  plan?: unknown[];
}

/** POST /api/runs: the HTTP status, and the run id when the run was created. */
export interface CreatedRun {
  http: number;
  runId?: string;
  error?: RunError;
}

export interface RunClient {
  api: ApiCall;
  /** Waits between polls and preview attempts (default: a timer). */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollOptions {
  /** Between polls (default 2 s). */
  intervalMs?: number;
  /** Polls before giving up with status `timeout` (default 90, i.e. three minutes). */
  polls?: number;
}

export interface PreviewOptions extends PollOptions {
  /** Preview attempts in all while the preview fails (default 6). */
  previewAttempts?: number;
  /** Between preview attempts (default 10 s). */
  retryDelayMs?: number;
  /** Called before each retry with the failed preview (scripts print why). */
  onRetry?: (attempt: number, preview: RunDetail) => void;
}

export interface PreviewThenRunOptions extends PreviewOptions {
  /** The typed confirmation for the real run, read from the preview (undefined: none is sent). */
  confirm?: (preview: RunDetail) => string | undefined;
}

const SETTLED = new Set<string>([...TERMINAL_RUN_STATUSES, ...PARKED_RUN_STATUSES]);
const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True once a run stops moving on its own: finished, or parked until a person acts. */
export const isSettled = (status: string): boolean => SETTLED.has(status);

/** POST /api/runs with `body` (playbook, inputs, dryRun, previewRunId, confirmation). */
export async function createRun(c: RunClient, body: Record<string, unknown>): Promise<CreatedRun> {
  const r = await c.api<{ runId?: string; error?: RunError } | undefined>('POST', '/api/runs', body);
  return {
    http: r.status,
    ...(r.json?.runId ? { runId: r.json.runId } : {}),
    ...(r.json?.error ? { error: r.json.error } : {}),
  };
}

/**
 * The run's detail once it settles. A run that doesn't settle within `polls` comes back as status `timeout`; a read
 * the API refuses comes back as status `http <status>` with the API's error.
 */
export async function waitForRun(c: RunClient, runId: string, opts: PollOptions = {}): Promise<RunDetail> {
  const sleep = c.sleep ?? timer;
  for (let i = 0; i < (opts.polls ?? 90); i++) {
    const r = await c.api<RunDetail & { error?: RunError }>('GET', `/api/runs/${encodeURIComponent(runId)}`);
    if (r.status !== 200)
      return {
        run: { status: `http ${r.status}`, ...(r.json?.error ? { error: r.json.error } : {}) },
        steps: [],
      };
    if (isSettled(r.json.run.status)) return r.json;
    await sleep(opts.intervalMs ?? 2000);
  }
  return { run: { status: 'timeout' }, steps: [] };
}

/** `waitForRun` for a created run; one that wasn't created comes back as `not created (http <status>)`. */
export async function settle(
  c: RunClient,
  created: CreatedRun | undefined,
  opts: PollOptions = {},
): Promise<RunDetail> {
  if (!created?.runId)
    return {
      run: {
        status: `not created (http ${created?.http ?? '-'})`,
        ...(created?.error ? { error: created.error } : {}),
      },
      steps: [],
    };
  return waitForRun(c, created.runId, opts);
}

/** A dry run with these inputs, settled; retried while it fails (see the module comment). */
export async function preview(
  c: RunClient,
  playbook: string,
  inputs: unknown,
  opts: PreviewOptions = {},
): Promise<{ created: CreatedRun; detail: RunDetail }> {
  const sleep = c.sleep ?? timer;
  for (let attempt = 1; ; attempt++) {
    const created = await createRun(c, { playbook, inputs, dryRun: true });
    const detail = await settle(c, created, opts);
    if (detail.run.status !== 'failed' || attempt >= (opts.previewAttempts ?? 6)) return { created, detail };
    opts.onRetry?.(attempt, detail);
    await sleep(opts.retryDelayMs ?? 10_000);
  }
}

/** A step's output in a run — its last succeeded attempt, which is what the UI reads a typed confirmation from. */
export function stepOutput(detail: RunDetail, stepId: string): Record<string, unknown> | undefined {
  return detail.steps.filter((s) => s.stepId === stepId && s.status === 'succeeded').at(-1)?.output;
}

/**
 * Preview, then — only when the preview succeeded — create the real run with its id (and `confirm`'s text). The real
 * run is created, not awaited: `settle(c, run)` waits for it. Without a succeeded preview `run` is absent.
 */
export async function previewThenRun(
  c: RunClient,
  playbook: string,
  inputs: unknown,
  opts: PreviewThenRunOptions = {},
): Promise<{ preview: RunDetail; run?: CreatedRun }> {
  const p = await preview(c, playbook, inputs, opts);
  if (p.detail.run.status !== 'succeeded' || !p.created.runId) return { preview: p.detail };
  const confirmation = opts.confirm?.(p.detail);
  const run = await createRun(c, {
    playbook,
    inputs,
    dryRun: false,
    previewRunId: p.created.runId,
    ...(confirmation !== undefined ? { confirmation } : {}),
  });
  return { preview: p.detail, run };
}
