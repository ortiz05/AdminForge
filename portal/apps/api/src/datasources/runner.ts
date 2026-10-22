import { randomUUID } from 'node:crypto';
import { IdentityUnavailable, StepError, type ResolvedIdentity } from '@adminforge/engine';
import type { TokenBroker } from '../auth/token-broker';
import { NotArmed, ReauthRequired } from '../auth/types';
import type { Config } from '../config';
import { AppError } from '../errors';
import { runnerSlots, type RunnerSlots } from '../execution/runner-slots';
import { createRunnerPort } from '../runs/ports';
import type { RunnerExec } from './executor';

/**
 * Live PowerShell datasources over the runs worker's runner adapter (one implementation of the runner protocol:
 * signing, token forwarding, NDJSON). The datasource result is every `output` event's data, in order; engine errors
 * become API errors (re-auth / not armed / runner failures with their codes).
 */
export function liveRunner(opts: {
  url: string;
  key: string;
  broker: TokenBroker | null;
  config: Pick<Config, 'AF_TENANT_ID' | 'AF_PRIMARY_DOMAIN' | 'AF_SPO_TENANT_NAME'> &
    Partial<Pick<Config, 'RUNNER_JOBS_PER_PERSON'>>;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: { warn(obj: object, msg: string): void };
}): RunnerExec | undefined {
  let port: ReturnType<typeof createRunnerPort>;
  try {
    port = createRunnerPort({
      url: opts.url,
      key: opts.key,
      broker: opts.broker,
      tenant: {
        id: opts.config.AF_TENANT_ID,
        domain: opts.config.AF_PRIMARY_DOMAIN,
        spoTenantName: opts.config.AF_SPO_TENANT_NAME,
      },
      fetch: opts.fetch,
      now: opts.now,
    });
  } catch (err) {
    opts.log?.warn({ err: { message: (err as Error).message } }, 'PowerShell datasources disabled');
    return undefined;
  }
  const exec: RunnerExec = {
    async run(identity, job, { correlationId, signal }) {
      const outputs: unknown[] = [];
      const resolved: ResolvedIdentity = {
        actor:
          identity.kind === 'delegated'
            ? { kind: 'delegated', oid: identity.session.userOid, upn: identity.session.upn }
            : { kind: 'automation', oid: null, upn: null },
        mode: identity.mode,
        handle: identity,
      };
      try {
        const res = await port.run(
          resolved,
          {
            jobId: `ds-${correlationId}-${randomUUID()}`,
            script: job.script,
            sha256: job.sha256,
            parameters: job.parameters,
            services: job.services,
            timeoutSeconds: job.timeoutSeconds,
            mode: job.mode,
          },
          {
            signal: signal ?? new AbortController().signal,
            onEvent: (e) => {
              if (e.type === 'output') outputs.push(e.data);
            },
          },
        );
        if (res.status !== 'succeeded')
          throw new AppError(
            502,
            `runner_${res.status}`,
            res.error?.message ??
              `The PowerShell script ${res.status === 'timeout' ? 'timed out' : res.status}.`,
            {
              hint:
                res.status === 'timeout'
                  ? `Scripts run for at most ${job.timeoutSeconds} s.`
                  : 'Try again. If it keeps failing, give a portal administrator the reference: the PowerShell runner log has the script error.',
            },
          );
        return { data: outputs };
      } catch (err) {
        if (err instanceof IdentityUnavailable)
          throw err.reason === 'not_armed' ? new NotArmed(err.message) : new ReauthRequired('read');
        if (err instanceof StepError) {
          const status =
            err.opts.status && err.opts.status >= 400 && err.opts.status < 600 ? err.opts.status : 502;
          throw new AppError(
            status,
            err.code,
            err.message,
            status === 503
              ? { hint: 'Every PowerShell worker is busy or starting. Try again in a minute.' }
              : undefined,
          );
        }
        throw err;
      }
    },
  };
  return perPersonLimit(exec, opts.config.RUNNER_JOBS_PER_PERSON ?? 3);
}

/**
 * At most `limit` PowerShell jobs per signed-in person at once (RunnerSlots, shared with playbook steps): a datasource
 * read beyond that is refused (429 `runner_busy_for_you`) rather than queued.
 */
export function perPersonLimit(
  exec: RunnerExec,
  limit: number,
  slots: RunnerSlots = runnerSlots,
): RunnerExec {
  return {
    async run(identity, job, opts) {
      const who = identity.kind === 'delegated' ? identity.session.userOid : null;
      if (!who) return exec.run(identity, job, opts);
      const release = slots.tryTake(who, limit);
      if (!release)
        throw new AppError(
          429,
          'runner_busy_for_you',
          `You already have ${limit} PowerShell jobs running, so AdminForge didn’t start another.`,
          { hint: 'Wait for them to finish (or close the pages that started them), then try again.' },
        );
      try {
        return await exec.run(identity, job, opts);
      } finally {
        release();
      }
    },
  };
}
