/**
 * Runs the `tests:` blocks of playbooks and runbooks — dry runs with mocked step outputs, through the engine's
 * `runPlaybookTests` — for `adminforge test` and the gate in `adminforge publish`.
 *
 * Returns the results as data (counts plus one ✓/✗ line per test) and prints nothing, so each command decides what to
 * show. The engine is loaded dynamically and typed structurally (`EngineModule`), so the CLI type-checks without the
 * engine's internals and tests can inject a stand-in; when it can't be loaded, `ran` is false and nothing runs.
 * Definitions that parse are tested even when other files have problems (validate reports those). No network: step
 * outputs come from the tests themselves.
 */
import {
  formatContentError,
  loadContentDir,
  type Definition,
  type LoadedDefinition,
} from '@adminforge/schemas';

/** The slice of @adminforge/engine used here (structural, so the CLI type-checks independently of the engine). */
export interface EngineModule {
  runPlaybookTests(
    def: Definition,
    opts?: {
      resolveChild?: (ref: string, version?: string) => Definition | null;
      env?: Record<string, unknown>;
    },
  ): Promise<Array<{ name: string; passed: boolean; failures: string[]; status: string }>>;
}

/** The engine, or null when it can't be loaded (then no tests run). */
async function loadEngine(): Promise<EngineModule | null> {
  try {
    const mod = (await import('@adminforge/engine')) as Partial<EngineModule>;
    return typeof mod.runPlaybookTests === 'function' ? (mod as EngineModule) : null;
  } catch {
    // Deliberately tolerated: callers report "engine not available" (`ran: false`) instead of failing to start.
    return null;
  }
}

export interface PlaybookTestRun {
  /** False when the engine could not be loaded (nothing ran). */
  ran: boolean;
  passed: number;
  failed: number;
  /** Definitions with tests (matching the pattern). */
  targets: number;
  /** One line per test (✓/✗), in order. */
  lines: string[];
  /** Parse problems of other files (validate reports them). */
  problems: string[];
}

/** Runs every playbook/runbook `tests:` block (dry run with mocked step outputs); prints nothing. */
export async function runPlaybookTests(
  /** The content directory; `engine` injects the engine (tests), null meaning "not available". */
  ctx: { contentDir: string; engine?: EngineModule | null },
  opts: { pattern?: string; loaded?: LoadedDefinition[] } = {},
): Promise<PlaybookTestRun> {
  const run: PlaybookTestRun = { ran: false, passed: 0, failed: 0, targets: 0, lines: [], problems: [] };
  const engine = ctx.engine !== undefined ? ctx.engine : await loadEngine();
  if (!engine) return run;
  run.ran = true;
  // Definitions that parsed are tested even when other files have problems (adminforge validate reports those).
  let definitions = opts.loaded;
  if (!definitions) {
    const loaded = await loadContentDir(ctx.contentDir);
    definitions = loaded.definitions;
    run.problems = loaded.errors.map(formatContentError);
  }
  const byId = new Map(definitions.map((d) => [d.def.id, d.def]));
  const targets = definitions.filter(
    (d) =>
      (d.def.kind === 'playbook' || d.def.kind === 'runbook') &&
      d.def.tests?.length &&
      (!opts.pattern || d.def.id.includes(opts.pattern) || d.file.includes(opts.pattern)),
  );
  run.targets = targets.length;
  for (const d of targets) {
    let results: Awaited<ReturnType<EngineModule['runPlaybookTests']>>;
    try {
      results = await engine.runPlaybookTests(d.def, { resolveChild: (ref) => byId.get(ref) ?? null });
    } catch (err) {
      run.failed++;
      run.lines.push(`✗ ${d.def.id}: tests could not run — ${(err as Error).message}`);
      continue;
    }
    for (const r of results) {
      if (r.passed) run.passed++;
      else run.failed++;
      run.lines.push(
        `${r.passed ? '✓' : '✗'} ${d.def.id} › ${r.name}${r.passed ? '' : ` — ${r.failures.join('; ')}`}`,
      );
    }
  }
  return run;
}
