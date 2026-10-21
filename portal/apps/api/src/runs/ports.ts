import {
  decodeRunnerKey,
  prepareRunnerJob,
  readNdjson,
  readRunnerRefusal,
  RUNNER_MAX_TIMEOUT_SECONDS,
  RunnerEventVerifier,
  RunnerResponseError,
  type RunnerTokens,
} from '@adminforge/runner';
import type { ServiceId } from '@adminforge/connectors';
import {
  IdentityUnavailable,
  StepError,
  type OutboundPort,
  type ResolvedIdentity,
  type RunnerJob,
  type RunnerPort,
  type RunnerResult,
} from '@adminforge/engine';
import type { BrokerService, TokenBroker } from '../auth/token-broker';
import { NotArmed, ReauthRequired } from '../auth/types';
import { AppError } from '../errors';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '../execution/types';

/** Token/session failures from the API become engine parks (awaiting_arm / awaiting_reauth). */
function identityError(err: unknown): IdentityUnavailable | undefined {
  if (err instanceof NotArmed) return new IdentityUnavailable('not_armed', err.message);
  if (err instanceof ReauthRequired)
    return new IdentityUnavailable(
      err.kind === 'write' ? 'not_armed' : 'reauth',
      err.kind === 'write'
        ? 'Write access needs to be re-armed.'
        : 'The sign-in behind this run needs to be refreshed.',
    );
  return undefined;
}

/** API errors (policy denials, configuration) become non-retryable step errors with their code and hint. */
export function stepError(err: AppError): StepError {
  return new StepError(err.code, err.message, {
    status: err.status,
    ...(err.extras.hint ? { hint: err.extras.hint } : {}),
  });
}

/** OutboundPort over the API's OutboundExecutor (policy → token → connector). */
export function createOutboundPort(executor: () => OutboundExecutor | null): OutboundPort {
  return {
    async call(identity, call, opts) {
      const exec = executor();
      if (!exec)
        throw new StepError('outbound_unavailable', 'Outbound calls are not available in this process.');
      if (call.service === 'http')
        throw new StepError(
          'http_not_supported',
          'http steps are not enabled on this installation yet (no host allowlist is configured).',
        );
      try {
        const res = await exec.execute(identity.handle as ExecutionIdentity, call as ServiceCall, {
          correlationId: opts.correlationId,
          signal: opts.signal,
        });
        return {
          data: res.data,
          status: res.status,
          ...(res.provenance.requestId ? { requestId: res.provenance.requestId } : {}),
        };
      } catch (err) {
        const park = identityError(err);
        if (park) throw park;
        if (err instanceof AppError) throw stepError(err);
        throw err;
      }
    },
  };
}

export interface RunnerPortOptions {
  /** RUNNER_URL, e.g. http://127.0.0.1:3101 */
  url: string;
  /** RUNNER_SHARED_KEY (base64, ≥ 32 bytes). */
  key: string;
  broker: TokenBroker | null;
  tenant: { id?: string; domain?: string; spoTenantName?: string };
  fetch?: typeof fetch;
  now?: () => Date;
  /** Write jobs pass the same emergency stop and protected-object guard as REST writes. */
  outbound?: OutboundExecutor | null;
}

const RUNNER_SERVICES = new Set(['graph', 'exchange', 'teams', 'sharepointAdmin', 'arm']);

/** The runner's answer could not be verified: nothing of it is used and the step fails. */
function unverified(reason: string): StepError {
  return new StepError(
    'runner_unverified',
    'The answer of the PowerShell runner could not be verified, so it was discarded.',
    {
      status: 502,
      details: { reason },
      hint: 'Try again. If it keeps failing, give a portal administrator the reference: the answer did not come from the AdminForge runner, or the runner and the API use different keys.',
    },
  );
}

/** The step's identity for a PowerShell job: a person's (delegated) — scheduled runs can't run scripts yet. */
export function delegatedHandle(
  identity: ResolvedIdentity,
): Extract<ExecutionIdentity, { kind: 'delegated' }> {
  const exec = identity.handle as ExecutionIdentity;
  if (exec.kind !== 'delegated')
    throw new StepError(
      'runner_unsupported',
      'Scheduled (automation) runs cannot run PowerShell scripts yet.',
    );
  return exec;
}

/**
 * A write script passes the emergency stop and the protected-object guard like a REST write, its inputs checked like
 * a REST write's body (object ids; names and UPNs aren't matched). Reads pass.
 */
export async function assertWritableJob(
  outbound: OutboundExecutor | null | undefined,
  exec: ExecutionIdentity,
  job: RunnerJob,
): Promise<void> {
  if (job.mode !== 'write' || !outbound?.assertWritable) return;
  const targets = job.services.map((service) => ({
    service: service as ServiceId,
    method: 'POST',
    path: job.script,
    body: job.parameters,
  }));
  try {
    await outbound.assertWritable(exec, targets);
  } catch (err) {
    if (err instanceof AppError) throw stepError(err);
    throw err;
  }
}

/**
 * RunnerPort for the PowerShell runner (apps/runner, `POST /v1/jobs` → NDJSON events), implemented against its
 * protocol with the runner's own helpers: the request is HMAC-signed (timestamp, method, path, body hash), the
 * delegated tokens for the services the script declares are minted for the step's identity and mode and travel
 * only AES-256-GCM-sealed for this job, and the answer is used only after every event verified against the
 * request's nonce (a process answering on RUNNER_URL instead of the runner gets ciphertext and can't fake results).
 * Redirects are refused.
 */
export function createRunnerPort(opts: RunnerPortOptions): RunnerPort {
  const key = decodeRunnerKey(opts.key);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  return {
    async run(identity, job, { signal, onEvent }): Promise<RunnerResult> {
      const exec = delegatedHandle(identity);
      if (!opts.tenant.id || !opts.tenant.domain)
        throw new StepError(
          'runner_unavailable',
          'AF_TENANT_ID and AF_PRIMARY_DOMAIN must be configured for PowerShell steps.',
        );
      if (!opts.broker)
        throw new StepError(
          'runner_unavailable',
          'PowerShell steps need Entra sign-in (not available with mock sign-in).',
        );
      await assertWritableJob(opts.outbound, exec, job);
      const tokens: RunnerTokens = {};
      for (const service of job.services) {
        if (!RUNNER_SERVICES.has(service))
          throw new StepError('invalid_request', `Unknown runner service ${service}.`);
        try {
          tokens[service as keyof RunnerTokens] = await opts.broker.get(
            exec.session,
            service as BrokerService,
            job.mode,
          );
        } catch (err) {
          const park = identityError(err);
          if (park) throw park;
          if (err instanceof AppError) throw stepError(err);
          throw err;
        }
      }
      const prepared = prepareRunnerJob({
        key,
        timestamp: Math.floor(now().getTime() / 1000),
        job: {
          jobId: job.jobId,
          script: { path: job.script, sha256: job.sha256 },
          inputs: job.parameters,
          mode: job.mode,
          tokens,
          tenant: {
            id: opts.tenant.id,
            domain: opts.tenant.domain,
            ...(opts.tenant.spoTenantName ? { spoTenantName: opts.tenant.spoTenantName } : {}),
          },
          ...(job.timeoutSeconds
            ? { timeoutSeconds: Math.min(job.timeoutSeconds, RUNNER_MAX_TIMEOUT_SECONDS) }
            : {}),
        },
      });
      let res: Response;
      try {
        res = await doFetch(new URL('/v1/jobs', opts.url), {
          method: 'POST',
          headers: prepared.headers,
          body: prepared.body,
          redirect: 'error',
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new StepError(
          'runner_unreachable',
          `The PowerShell runner is not reachable: ${(err as Error).message}`,
          { transient: true },
        );
      }
      if (res.status !== 200 || !res.body) {
        const refusal = await readRunnerRefusal(res, { key, nonce: prepared.nonce });
        if (!refusal.verified)
          throw new StepError(
            'runner_error',
            `The PowerShell runner refused the job (HTTP ${res.status}), and its answer could not be verified.`,
            {
              status: res.status >= 400 && res.status < 600 ? res.status : 502,
              hint: 'Give a portal administrator the reference: the runner may be misconfigured or another program is answering in its place.',
            },
          );
        throw new StepError(`runner_${refusal.code}`.replace(/^runner_runner_/, 'runner_'), refusal.message, {
          status: res.status,
          transient: res.status === 429 || res.status === 503,
        });
      }
      const verifier = new RunnerEventVerifier(key, prepared.jobId, prepared.nonce);
      const outputs: unknown[] = [];
      let error: RunnerResult['error'];
      let status: RunnerResult['status'] = 'failed';
      try {
        for await (const raw of readNdjson(res.body)) {
          // Nothing reaches the run before it verified: an unsigned, foreign or reordered event ends the step.
          const e = verifier.accept(raw);
          if (e.type === 'log')
            await onEvent({
              type: 'log',
              level: (['debug', 'info', 'warn', 'error'].includes(String(e.level))
                ? e.level
                : 'info') as 'info',
              message: String(e.message ?? ''),
            });
          else if (e.type === 'progress')
            await onEvent({
              type: 'progress',
              percent: Number(e.percent) || 0,
              message: String(e.message ?? ''),
            });
          else if (e.type === 'output') {
            outputs.push(e.data ?? null);
            await onEvent({ type: 'output', data: e.data ?? null });
          } else if (e.type === 'error')
            error = {
              message: String(e.message ?? 'Script failed'),
              category: String(e.category ?? 'script'),
            };
          else if (e.type === 'done') {
            status = (
              ['succeeded', 'failed', 'timeout', 'cancelled'].includes(String(e.status)) ? e.status : 'failed'
            ) as RunnerResult['status'];
            break;
          }
        }
      } catch (err) {
        if (err instanceof RunnerResponseError) throw unverified(err.message);
        if (err instanceof SyntaxError) throw unverified('the answer is not NDJSON');
        throw err;
      }
      if (!verifier.finished) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
        throw unverified(
          verifier.accepted ? 'the answer ended before the job finished' : 'the job was never accepted',
        );
      }
      return {
        status,
        output: outputs.length <= 1 ? (outputs[0] ?? null) : outputs,
        ...(error ? { error } : {}),
      };
    },
  };
}
