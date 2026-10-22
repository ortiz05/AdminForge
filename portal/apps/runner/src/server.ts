import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { type AuthFailureReason, verifyRunnerRequest } from './auth';
import { RUNNER_TIMESTAMP_HEADER } from './client';
import { type RunnerConfig, buildWorkerCommand } from './config';
import {
  RESPONSE_NONCE_RE,
  RESPONSE_SIGNATURE_HEADER,
  RunnerEventSigner,
  SealedTokensError,
  openRunnerTokens,
  signRunnerResponse,
} from './crypto';
import { type ModulesLock, healthReport, readModulesLock } from './health';
import { JobManager, JobRejectedError } from './jobs';
import { type RunnerLogger, WorkerPool } from './pool';
import {
  type RunnerEvent,
  type RunnerJob,
  RunnerJobRequestSchema,
  RunnerTokensSchema,
  type RunnerTokens,
} from './protocol';
import { REDACTED, redactDeep } from './redact';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface RunnerServerOptions {
  config: RunnerConfig;
  /** Inject a pool (tests use a fake worker command). Started by the server; closed with it. */
  pool?: WorkerPool;
  /** Fastify/pino logger options, or false. Token redaction is always added. */
  logger?: boolean | Record<string, unknown>;
  nowSeconds?: () => number;
  /** Interval of blank keep-alive lines on job streams. */
  keepAliveMs?: number;
  modulesLock?: ModulesLock;
}

const AUTH_MESSAGES: Record<AuthFailureReason, string> = {
  missing_signature: 'Missing Authorization: AdminForge-HMAC <signature>',
  malformed_signature: 'Malformed Authorization header',
  missing_timestamp: 'Missing X-AdminForge-Timestamp header',
  stale_timestamp: 'X-AdminForge-Timestamp is outside the allowed window',
  before_start: 'X-AdminForge-Timestamp is older than this runner process (a replayed request)',
  bad_signature: 'Signature does not match',
};

const EMPTY = Buffer.alloc(0);

function loggerOptions(option: RunnerServerOptions['logger']): FastifyServerOptions['logger'] {
  if (option === false) return false;
  const base = typeof option === 'object' ? option : { level: process.env.LOG_LEVEL ?? 'info' };
  return {
    ...base,
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-adminforge-timestamp"]'],
      censor: REDACTED,
    },
    hooks: {
      // Defence in depth: nothing that looks like a token reaches the supervisor's log.
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(this, redactDeep(args));
      },
    },
  } as FastifyServerOptions['logger'];
}

export async function buildRunnerServer(opts: RunnerServerOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({ logger: loggerOptions(opts.logger), bodyLimit: 4 * 1024 * 1024 });
  const log = app.log as unknown as RunnerLogger;
  const pool =
    opts.pool ??
    new WorkerPool({
      command: buildWorkerCommand(config),
      size: config.poolSize,
      maxJobs: config.maxJobs,
      logger: log,
    });
  const jobs = new JobManager({
    pool,
    scriptsDir: config.scriptsDir,
    queueTimeoutMs: config.queueTimeoutMs,
    maxWaiting: config.maxWaiting,
    logger: log,
  });
  const lock = opts.modulesLock ?? readModulesLock();
  const keepAliveMs = opts.keepAliveMs ?? 15_000;
  // Job ids are remembered in memory only; requests signed before this process started are replays.
  const startedAtSeconds = opts.nowSeconds?.() ?? Math.floor(Date.now() / 1000);

  // Keep the raw bytes: the signature covers them exactly. JSON is parsed only after verification.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    done(null, undefined);
  });

  app.addHook('preValidation', async (request, reply) => {
    const raw = request.rawBody ?? EMPTY;
    const header = request.headers[RUNNER_TIMESTAMP_HEADER];
    const result = verifyRunnerRequest({
      key: config.sharedKey,
      authorization: request.headers.authorization,
      timestamp: Array.isArray(header) ? header[0] : header,
      method: request.method,
      path: request.raw.url ?? request.url,
      body: raw,
      nowSeconds: opts.nowSeconds?.(),
      notBeforeSeconds: startedAtSeconds,
    });
    if (!result.ok) {
      request.log.warn(
        { reason: result.reason, url: request.url },
        'rejected unauthenticated runner request',
      );
      return reply.code(401).send({ error: 'unauthorized', message: AUTH_MESSAGES[result.reason] });
    }
    if (raw.length) {
      try {
        request.body = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'invalid_request', message: 'Body is not valid JSON' });
      }
    }
    return undefined;
  });

  app.get('/healthz', async (_request, reply) => {
    const report = healthReport(config, pool, lock, jobs.runningCount);
    return reply.code(report.status === 'unavailable' ? 503 : 200).send(report);
  });

  app.post('/v1/jobs', async (request, reply) => {
    // The request is authenticated (preValidation). Its nonce, when well-formed, lets the API verify refusals.
    const rawNonce = (request.body as { nonce?: unknown } | undefined)?.nonce;
    const nonce = typeof rawNonce === 'string' && RESPONSE_NONCE_RE.test(rawNonce) ? rawNonce : undefined;
    const refuse = (status: number, payload: Record<string, unknown>) => {
      const text = JSON.stringify(payload);
      reply.code(status).type('application/json; charset=utf-8');
      if (nonce)
        reply.header(
          RESPONSE_SIGNATURE_HEADER,
          signRunnerResponse({ key: config.sharedKey, nonce, status, body: text }),
        );
      return reply.send(text);
    };

    const parsed = RunnerJobRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return refuse(400, {
        error: 'invalid_request',
        message: 'The job request is invalid',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { sealedTokens, nonce: jobNonce, ...wire } = parsed.data;
    let tokens: RunnerTokens = {};
    if (sealedTokens !== undefined) {
      const header = request.headers[RUNNER_TIMESTAMP_HEADER];
      let opened: unknown;
      try {
        opened = openRunnerTokens({
          key: config.sharedKey,
          jobId: wire.jobId,
          timestamp: (Array.isArray(header) ? header[0] : header) ?? '',
          sealed: sealedTokens,
        });
      } catch (error) {
        if (!(error instanceof SealedTokensError)) throw error;
        request.log.warn({ jobId: wire.jobId }, 'job refused: sealed tokens could not be opened');
        return refuse(400, {
          error: 'invalid_request',
          message: 'The tokens of this job could not be decrypted for this job and request',
        });
      }
      const checked = RunnerTokensSchema.safeParse(opened);
      if (!checked.success)
        return refuse(400, { error: 'invalid_request', message: 'The decrypted tokens are invalid' });
      tokens = checked.data;
    }
    const runnerJob: RunnerJob = { ...wire, tokens };

    let admitted;
    try {
      admitted = await jobs.admit(runnerJob);
    } catch (error) {
      if (!(error instanceof JobRejectedError)) throw error;
      if (error.statusCode === 503) reply.header('retry-after', '10');
      request.log.warn({ jobId: wire.jobId, script: wire.script.path, code: error.code }, 'job refused');
      return refuse(error.statusCode, { error: error.code, message: error.message });
    }

    const jobId = wire.jobId;
    const signer = new RunnerEventSigner(config.sharedKey, jobId, jobNonce);
    const stream = new PassThrough();
    let finished = false;
    const write = (event: RunnerEvent) => {
      if (!stream.writableEnded) stream.write(signer.line(event));
    };
    const keepAlive = setInterval(() => {
      if (!stream.writableEnded) stream.write('\n');
    }, keepAliveMs);
    reply.raw.on('close', () => {
      if (!finished) jobs.cancel(jobId, 'client disconnected');
    });
    void jobs
      .run(admitted, write)
      .catch((error: unknown) => request.log.error({ jobId, err: error }, 'job crashed'))
      .finally(() => {
        finished = true;
        clearInterval(keepAlive);
        stream.end();
      });
    return reply
      .code(200)
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(stream);
  });

  app.post<{ Params: { id: string } }>('/v1/jobs/:id/cancel', async (request, reply) => {
    if (!jobs.cancel(request.params.id, 'cancelled by request')) {
      return reply.code(404).send({ error: 'job_not_found', message: 'No running job with that id' });
    }
    return reply.code(202).send({ jobId: request.params.id, status: 'cancelling' });
  });

  app.addHook('onClose', async () => {
    jobs.cancelAll('runner shutting down');
    await pool.close();
  });

  pool.start();
  return app;
}
