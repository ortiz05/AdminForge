import { decodeRunnerKey, RUNNER_MAX_TIMEOUT_SECONDS, signRunnerRequest } from '@adminforge/runner';
import {
  IdentityUnavailable,
  StepError,
  type OutboundPort,
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
function stepError(err: AppError): StepError {
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
}

const RUNNER_SERVICES = new Set(['graph', 'exchange', 'teams', 'sharepointAdmin', 'arm']);

/** NDJSON lines from a fetch body. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line) as unknown;
        nl = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/**
 * RunnerPort for the PowerShell runner (apps/runner, `POST /v1/jobs` → NDJSON events), implemented against its
 * protocol, signed with the runner's own `signRunnerRequest` (HMAC over timestamp, method, path, and body hash). Delegated tokens for the services the script declares are minted for the step's
 * identity and mode, and travel only in the job body (stdin on the runner side).
 */
export function createRunnerPort(opts: RunnerPortOptions): RunnerPort {
  const key = decodeRunnerKey(opts.key);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  return {
    async run(identity, job, { signal, onEvent }): Promise<RunnerResult> {
      const exec = identity.handle as ExecutionIdentity;
      if (exec.kind !== 'delegated')
        throw new StepError(
          'runner_unsupported',
          'Scheduled (automation) runs cannot run PowerShell scripts yet.',
        );
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
      const tokens: Record<string, string> = {};
      for (const service of job.services) {
        if (!RUNNER_SERVICES.has(service))
          throw new StepError('invalid_request', `Unknown runner service ${service}.`);
        try {
          tokens[service] = await opts.broker.get(exec.session, service as BrokerService, job.mode);
        } catch (err) {
          const park = identityError(err);
          if (park) throw park;
          if (err instanceof AppError) throw stepError(err);
          throw err;
        }
      }
      const body = JSON.stringify({
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
      });
      const signed = signRunnerRequest({
        key,
        method: 'POST',
        path: '/v1/jobs',
        body,
        timestamp: Math.floor(now().getTime() / 1000),
      });
      let res: Response;
      try {
        res = await doFetch(new URL('/v1/jobs', opts.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...signed },
          body,
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
        let code = 'runner_error';
        let message = `The runner answered ${res.status}.`;
        try {
          const p = (await res.json()) as { error?: unknown; message?: unknown };
          if (typeof p.error === 'string') code = p.error;
          if (typeof p.message === 'string') message = p.message;
        } catch {
          // non-JSON
        }
        throw new StepError(`runner_${code}`.replace(/^runner_runner_/, 'runner_'), message, {
          status: res.status,
          transient: res.status === 429 || res.status === 503,
        });
      }
      const outputs: unknown[] = [];
      let error: RunnerResult['error'];
      let status: RunnerResult['status'] = 'failed';
      for await (const raw of ndjson(res.body)) {
        const e = raw as { type?: string; [k: string]: unknown };
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
          error = { message: String(e.message ?? 'Script failed'), category: String(e.category ?? 'script') };
        else if (e.type === 'done')
          status = (
            ['succeeded', 'failed', 'timeout', 'cancelled'].includes(String(e.status)) ? e.status : 'failed'
          ) as RunnerResult['status'];
      }
      return {
        status,
        output: outputs.length <= 1 ? (outputs[0] ?? null) : outputs,
        ...(error ? { error } : {}),
      };
    },
  };
}
