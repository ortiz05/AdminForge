import type { RunnerPort, RunnerResult } from '@adminforge/engine';
import { fixtureRunner } from '../datasources/executor';
import { AppError } from '../errors';
import type { OutboundExecutor } from '../execution/types';
import { assertWritableJob, delegatedHandle, stepError } from './ports';

export interface FixtureRunnerPortOptions {
  /** ADMINFORGE_FIXTURES_DIR: a script answers from `runner/<script path>.json` there. */
  dir: string;
  /** Mock sign-in: a write script no fixture describes succeeds (there is no tenant to change). */
  acceptUnfixturedWrites: boolean;
  /** Write scripts pass the emergency stop and the protected-object guard, as with the real runner. */
  outbound?: OutboundExecutor | null;
}

/**
 * The PowerShell runner of DATA_MODE=fixtures (security review M2): a playbook's PowerShell step answers from the same
 * fixture files as a `source: runner` datasource (`fixtureRunner`: the output data array, or `$fixture` variants
 * matched on the parameters) and never reaches the runner, whose delegated tokens would change the real tenant while
 * every REST step and the protected-object guard read fixtures. A write script still passes the emergency stop and the
 * protected-object guard. With mock sign-in a write no fixture describes succeeds with no output, as the fixture fetch
 * accepts an unfixtured REST write; with Entra sign-in it fails like one.
 */
export function createFixtureRunnerPort(opts: FixtureRunnerPortOptions): RunnerPort {
  const files = fixtureRunner(opts.dir);
  return {
    async run(identity, job, { signal, onEvent }): Promise<RunnerResult> {
      const exec = delegatedHandle(identity);
      await assertWritableJob(opts.outbound, exec, job);
      let data: unknown[];
      try {
        ({ data } = await files.run(
          exec,
          { ...job, timeoutSeconds: job.timeoutSeconds ?? 0 },
          { correlationId: job.jobId, signal },
        ));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        if (err.code === 'upstream_not_found' && job.mode === 'write' && opts.acceptUnfixturedWrites)
          return { status: 'succeeded', output: null };
        throw stepError(err);
      }
      for (const d of data) await onEvent({ type: 'output', data: d });
      // As from the runner: one output event's data, or all of them when the script emitted several.
      return { status: 'succeeded', output: data.length <= 1 ? (data[0] ?? null) : data };
    },
  };
}
