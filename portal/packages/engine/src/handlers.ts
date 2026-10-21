import { isForbiddenHeader } from '@adminforge/connectors';
import { encodePathSegment, odataLiteral } from '@adminforge/expressions';
import type { Compensation, Step } from '@adminforge/schemas';
import { StepError } from './errors';
import type {
  NotifyMessage,
  Notifier,
  OutboundPort,
  Prepared,
  ServiceCall,
  StepContext,
  StepHandler,
  StepHandlerRegistry,
  StepResult,
} from './ports';
import { redact } from './redact';
import { isParked, isTerminal } from './types';

/**
 * Built-in handlers for leaf step types (§7.7). Service steps render a ServiceCall and go through the OutboundPort
 * (policy → token → connector in the API); `runner`, `notify` and `playbook` use their own ports; `transform` and
 * `assert` are pure. Compensation blocks reuse the same handlers.
 */

type StepOf<T extends string> = Extract<Step | Compensation, { type: T }>;
type Query = NonNullable<ServiceCall['query']>;

const RESOURCE_GRAPH_PATH = '/providers/Microsoft.ResourceGraph/resources';
const RESOURCE_GRAPH_API_VERSION = '2022-10-01';

function asQuery(v: unknown, field: string): Query | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v))
    throw new StepError('invalid_request', `${field} must render to an object.`);
  const out: Query = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined || x === null || x === '') continue;
    out[k] = typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? x : JSON.stringify(x);
  }
  return out;
}

function asHeaders(v: unknown): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v))
    throw new StepError('invalid_request', 'headers must render to an object.');
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    // Headers content may never set (the executor owns auth and correlation): one list, in the connectors (S-02).
    if (isForbiddenHeader(k)) throw new StepError('invalid_request', `Header ${k} cannot be set by content.`);
    if (x !== undefined && x !== null) out[k] = String(x);
  }
  return Object.keys(out).length ? out : undefined;
}

function asPath(v: unknown, field = 'path'): string {
  if (typeof v !== 'string' || !v.startsWith('/'))
    throw new StepError('invalid_request', `${field} must render to a path starting with /.`);
  return v;
}

const methodOf = (m: unknown) => (typeof m === 'string' && m ? m.toUpperCase() : 'GET');

const planOf = (call: ServiceCall, body: unknown) => ({
  service: call.service,
  method: call.method,
  path: call.path,
  ...(call.url ? { url: call.url } : {}),
  ...(call.query && Object.keys(call.query).length ? { query: { ...call.query } } : {}),
  ...(body !== undefined ? { body } : {}),
});

/** Prepared for a ServiceCall: plan + redacted request, payload = the call. */
function prepared(call: ServiceCall): Prepared {
  const body = call.body === undefined ? undefined : redact(call.body);
  const plan = planOf(call, body);
  return { plan, request: plan, payload: call };
}

async function callService(prep: Prepared, ctx: StepContext): Promise<StepResult> {
  const res = await ctx.ports.outbound.call(ctx.identity!, prep.payload as ServiceCall, {
    correlationId: ctx.correlationId,
    signal: ctx.signal,
  });
  return { output: res.data ?? null, ...(res.requestId ? { requestId: res.requestId } : {}) };
}

const declared = (ctx: StepContext) => (ctx.mode === 'write' ? { declaredWrite: true } : {});

/** `idempotent: false` (a write whose second send would hurt): the executor sends its call at most once (L2). */
const once = (step: Step | Compensation) =>
  'idempotent' in step && step.idempotent === false ? { idempotent: false as const } : {};

const graph: StepHandler = {
  external: true,
  async prepare(step: StepOf<'graph'>, ctx) {
    const r = await ctx.render<Record<string, unknown>>(step.request);
    return prepared({
      service: 'graph',
      method: methodOf(r.method),
      path: asPath(r.path),
      query: asQuery(r.query, 'query'),
      headers: asHeaders(r.headers),
      body: r.body,
      ...(r.beta ? { beta: true } : {}),
      ...declared(ctx),
      ...once(step),
      paging: step.paging ?? 'none',
      ...(step.maxItems ? { maxItems: step.maxItems } : {}),
    });
  },
  execute: callService,
};

function batchUrl(path: string, query: Query | undefined): string {
  const qs = query
    ? Object.entries(query).map(
        ([k, v]) => `${encodeURIComponent(k).replace(/%24/g, '$')}=${encodeURIComponent(String(v))}`,
      )
    : [];
  return `${path}${qs.length ? `?${qs.join('&')}` : ''}`;
}

const graphBatch: StepHandler = {
  external: true,
  async prepare(step: StepOf<'graphBatch'>, ctx) {
    const requests: Array<Record<string, unknown>> = [];
    for (const [id, spec] of Object.entries(step.requests)) {
      const r = await ctx.render<Record<string, unknown>>(spec);
      const headers = asHeaders(r.headers);
      requests.push({
        id,
        method: methodOf(r.method),
        url: batchUrl(asPath(r.path, `requests.${id}.path`), asQuery(r.query, `requests.${id}.query`)),
        ...(headers ? { headers } : {}),
        ...(r.body !== undefined
          ? { body: r.body, headers: { 'Content-Type': 'application/json', ...headers } }
          : {}),
      });
    }
    if (requests.length > 20)
      throw new StepError('invalid_request', 'A graphBatch step can hold at most 20 requests.');
    return prepared({
      service: 'graph',
      method: 'POST',
      path: '/$batch',
      body: { requests },
      ...declared(ctx),
      ...once(step),
    });
  },
  async execute(prep, ctx) {
    const res = await callService(prep, ctx);
    const responses = (
      (
        res.output as {
          responses?: Array<{ id: string; status: number; body?: unknown; headers?: Record<string, string> }>;
        } | null
      )?.responses ?? []
    ).slice();
    const out: Record<string, unknown> = {};
    for (const r of responses) {
      if (r.status >= 400) {
        const err = (r.body as { error?: { code?: string; message?: string } } | undefined)?.error;
        const retry = Number(r.headers?.['Retry-After'] ?? r.headers?.['retry-after']);
        throw new StepError(
          err?.code ?? `HTTP${r.status}`,
          `Batch request ${r.id} failed: ${err?.message ?? `HTTP ${r.status}`}`,
          {
            status: r.status,
            transient: r.status === 429 || r.status >= 500,
            ...(Number.isFinite(retry) ? { retryAfterMs: retry * 1000 } : {}),
          },
        );
      }
      out[r.id] = r.body ?? null;
    }
    return { output: out, ...(res.requestId ? { requestId: res.requestId } : {}) };
  },
};

const arm: StepHandler = {
  external: true,
  async prepare(step: StepOf<'arm'>, ctx) {
    const r = await ctx.render<Record<string, unknown>>(step.request);
    if (typeof r.apiVersion !== 'string' || !r.apiVersion)
      throw new StepError('invalid_request', 'ARM requests need apiVersion.');
    return prepared({
      service: 'arm',
      method: methodOf(r.method),
      path: asPath(r.path),
      apiVersion: r.apiVersion,
      query: asQuery(r.query, 'query'),
      headers: asHeaders(r.headers),
      body: r.body,
      ...declared(ctx),
      ...once(step),
      paging: step.paging ?? 'none',
      ...(step.poll === false ? { poll: false } : { poll: true }),
    });
  },
  execute: callService,
};

const resourceGraph: StepHandler = {
  external: true,
  async prepare(step: StepOf<'resourceGraph'>, ctx) {
    const query = await ctx.render<unknown>(step.query);
    if (typeof query !== 'string' || !query.trim())
      throw new StepError('invalid_request', 'query must render to KQL text.');
    const subscriptions =
      step.subscriptions === undefined ? undefined : await ctx.render<unknown>(step.subscriptions);
    const managementGroups =
      step.managementGroups === undefined ? undefined : await ctx.render<unknown>(step.managementGroups);
    const body: Record<string, unknown> = { query };
    if (Array.isArray(subscriptions) && subscriptions.length) body.subscriptions = subscriptions;
    if (Array.isArray(managementGroups) && managementGroups.length) body.managementGroups = managementGroups;
    return prepared({
      service: 'arm',
      method: 'POST',
      path: RESOURCE_GRAPH_PATH,
      apiVersion: RESOURCE_GRAPH_API_VERSION,
      body,
      ...declared(ctx),
      paging: step.paging ?? 'none',
    });
  },
  execute: callService,
};

const logAnalytics: StepHandler = {
  external: true,
  async prepare(step: StepOf<'logAnalytics'>, ctx) {
    const workspace = await ctx.render<unknown>(step.workspace);
    const query = await ctx.render<unknown>(step.query);
    const timespan = step.timespan === undefined ? undefined : await ctx.render<unknown>(step.timespan);
    if (typeof workspace !== 'string' || !workspace)
      throw new StepError('invalid_request', 'workspace must render to a workspace id.');
    if (typeof query !== 'string' || !query.trim())
      throw new StepError('invalid_request', 'query must render to KQL text.');
    return prepared({
      service: 'logAnalytics',
      method: 'POST',
      path: `/v1/workspaces/${encodePathSegment(workspace)}/query`,
      body: { query, ...(typeof timespan === 'string' && timespan ? { timespan } : {}) },
    });
  },
  execute: callService,
};

const fn: StepHandler = {
  external: true,
  async prepare(step: StepOf<'function'>, ctx) {
    const pathParams =
      step.pathParams === undefined ? undefined : await ctx.render<Record<string, unknown>>(step.pathParams);
    const call: ServiceCall = {
      service: 'function',
      method: 'POST',
      path: `/${step.operation}`,
      connection: step.connection,
      operation: step.operation,
      ...(pathParams ? { pathParams } : {}),
      query: asQuery(step.query === undefined ? undefined : await ctx.render(step.query), 'query'),
      headers: asHeaders(step.headers === undefined ? undefined : await ctx.render(step.headers)),
      body: step.body === undefined ? undefined : await ctx.render(step.body),
      ...declared(ctx),
      ...once(step),
    };
    const p = prepared(call);
    return { ...p, plan: { ...p.plan!, method: 'CALL', path: `${step.connection}/${step.operation}` } };
  },
  execute: callService,
};

const http: StepHandler = {
  external: true,
  async prepare(step: StepOf<'http'>, ctx) {
    const r = await ctx.render<Record<string, unknown>>(step.request);
    if (typeof r.url !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/|$)/.test(r.url))
      throw new StepError('invalid_request', 'url must render to an absolute https:// URL.');
    const url = new URL(r.url);
    return prepared({
      service: 'http',
      method: methodOf(r.method),
      path: url.pathname,
      url: r.url,
      query: asQuery(r.query, 'query'),
      headers: asHeaders(r.headers),
      body: r.body,
      ...declared(ctx),
      ...once(step),
    });
  },
  execute: callService,
};

const notify: StepHandler = {
  external: true,
  async prepare(step: StepOf<'notify'>, ctx) {
    const toRaw = await ctx.render<unknown>(step.to);
    const to = (Array.isArray(toRaw) ? toRaw : [toRaw])
      .filter((x) => x !== undefined && x !== null && x !== '')
      .map(String);
    if (!to.length) throw new StepError('invalid_request', 'notify needs at least one recipient.');
    const subject = step.subject === undefined ? undefined : String((await ctx.render(step.subject)) ?? '');
    const message = String((await ctx.render(step.message)) ?? '');
    const msg: NotifyMessage = { channel: step.channel, to, ...(subject ? { subject } : {}), message };
    const body = redact({ to, ...(subject ? { subject } : {}), message });
    const plan = { service: 'notify', method: 'SEND', path: step.channel, body };
    return { plan, request: plan, payload: msg };
  },
  async execute(prep, ctx) {
    const res = await ctx.ports.notifier.send(ctx.identity!, prep.payload as NotifyMessage, {
      correlationId: ctx.correlationId,
      signal: ctx.signal,
    });
    return {
      output: {
        sent: true,
        channel: (prep.payload as NotifyMessage).channel,
        recipients: (prep.payload as NotifyMessage).to.length,
      },
      ...(res.requestId ? { requestId: res.requestId } : {}),
    };
  },
};

const runner: StepHandler = {
  external: true,
  async prepare(step: StepOf<'runner'>, ctx) {
    const parameters =
      step.parameters === undefined ? {} : await ctx.render<Record<string, unknown>>(step.parameters);
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
      throw new StepError('invalid_request', 'parameters must render to an object.');
    const job = {
      jobId: `${ctx.run.id}:${ctx.path}`,
      script: step.script,
      sha256: step.sha256,
      parameters,
      services: step.services ?? [],
      ...(step.timeoutSeconds ? { timeoutSeconds: step.timeoutSeconds } : {}),
      mode: ctx.mode,
    };
    const plan = { service: 'runner', method: 'RUN', path: step.script, body: redact(parameters) };
    return { plan, request: { ...plan, sha256: step.sha256, services: job.services }, payload: job };
  },
  async execute(prep, ctx) {
    if (!ctx.ports.runner)
      throw new StepError(
        'runner_unavailable',
        'The PowerShell runner is not configured for this installation.',
      );
    const job = { ...(prep.payload as Parameters<NonNullable<typeof ctx.ports.runner>['run']>[1]) };
    job.jobId = `${job.jobId}:${Date.now().toString(36)}`.slice(0, 128).replace(/[^A-Za-z0-9._:-]/g, '_');
    const res = await ctx.ports.runner.run(ctx.identity!, job, {
      signal: ctx.signal,
      onEvent: (e) =>
        e.type === 'log'
          ? ctx.emit({ type: 'log', level: e.level, data: { message: e.message } })
          : e.type === 'progress'
            ? ctx.emit({ type: 'progress', data: { percent: e.percent, message: e.message } })
            : ctx.emit({ type: 'output', data: { data: e.data } }),
    });
    if (res.status === 'succeeded') return { output: res.output ?? null };
    const message = res.error?.message ?? `Script ${res.status}.`;
    if (res.status === 'timeout') throw new StepError('timeout', message);
    if (res.status === 'cancelled') throw new StepError('cancelled', message);
    throw new StepError(
      res.error?.category === 'readOnly' ? 'read_only' : `script_${res.error?.category ?? 'failed'}`,
      message,
      { transient: res.error?.category === 'runner' },
    );
  },
};

const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

const transform: StepHandler = {
  external: false,
  async prepare(step: StepOf<'transform'>) {
    return { plan: null, request: null, payload: step.expression };
  },
  async execute(prep, ctx) {
    const v = await ctx.render(prep.payload as string);
    return { output: v === undefined ? null : v };
  },
};

const assert: StepHandler = {
  external: false,
  async prepare(step: StepOf<'assert'>) {
    return { plan: null, request: null, payload: step };
  },
  async execute(prep, ctx) {
    const step = prep.payload as StepOf<'assert'>;
    const ok = truthy(await ctx.render(step.that));
    if (!ok) {
      let message: string;
      try {
        message = String((await ctx.render(step.message)) ?? 'Assertion failed.');
      } catch {
        message = 'Assertion failed.';
      }
      throw new StepError('assertion_failed', message);
    }
    return { output: true };
  },
};

const playbook: StepHandler = {
  external: true,
  plansItself: true,
  async prepare(step: StepOf<'playbook'>, ctx) {
    const inputs = step.inputs === undefined ? {} : await ctx.render<Record<string, unknown>>(step.inputs);
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
      throw new StepError('invalid_request', 'inputs must render to an object.');
    const plan = {
      service: 'playbook',
      method: 'RUN',
      path: step.version ? `${step.ref}@${step.version}` : step.ref,
      body: redact(inputs),
    };
    return { plan, request: plan, payload: { ref: step.ref, version: step.version, inputs } };
  },
  async execute(prep, ctx) {
    if (!ctx.ports.children)
      throw new StepError('children_unavailable', 'Child playbooks are not available here.');
    if (ctx.depth + 1 > ctx.limits.maxChildDepth)
      throw new StepError(
        'limit_exceeded',
        `Child playbooks nest at most ${ctx.limits.maxChildDepth} levels.`,
      );
    const p = prep.payload as { ref: string; version?: string; inputs: Record<string, unknown> };
    const res = await ctx.ports.children.run({
      parent: ctx.run,
      path: ctx.path,
      stepId: ctx.stepId,
      ref: p.ref,
      ...(p.version ? { version: p.version } : {}),
      inputs: p.inputs,
      dryRun: ctx.dryRun,
      actor: ctx.actor,
      depth: ctx.depth + 1,
      signal: ctx.signal,
    });
    const plan = res.plan.map((e) => ({
      ...e,
      stepPath: `${ctx.path}>${e.stepPath}`,
      childRunId: e.childRunId ?? res.runId,
    }));
    if (res.status === 'succeeded') return { output: { runId: res.runId, outputs: res.outputs }, plan };
    if (isParked(res.status)) return { output: { runId: res.runId }, plan, park: { status: res.status } };
    if (res.status === 'running' && res.wakeAt)
      return { output: { runId: res.runId }, plan, park: { status: 'running', wakeAt: res.wakeAt } };
    const ended = isTerminal(res.status) ? `ended ${res.status}` : `did not finish (${res.status})`;
    return {
      output: { runId: res.runId, outputs: res.outputs },
      plan,
      error: {
        code: `child_${res.status}`,
        message: res.error?.message
          ? `Child playbook ${p.ref} ${ended}: ${res.error.message}`
          : `Child playbook ${p.ref} ${ended}.`,
        details: { childRunId: res.runId },
      },
    };
  },
};

/** The default handler registry; override entries via EngineOptions.handlers. */
export const builtinHandlers: StepHandlerRegistry = {
  graph,
  graphBatch,
  arm,
  resourceGraph,
  logAnalytics,
  function: fn,
  http,
  notify,
  runner,
  transform,
  assert,
  playbook,
};

const html = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Notifier over Microsoft Graph, sent as the step's identity (delegated): email via /me/sendMail, Teams channel
 * messages, Teams chats (a chat id, or a user id/UPN → one-on-one chat). Message text is sent as plain text/escaped HTML.
 */
export function createGraphNotifier(outbound: OutboundPort): Notifier {
  return {
    async send(identity, msg, opts) {
      if (identity.actor.kind !== 'delegated')
        throw new StepError(
          'notify_unsupported',
          'notify steps send as a signed-in engineer; scheduled runs use the schedule’s own notify targets.',
        );
      const post = (path: string, body: unknown, extra: { chatMembers?: boolean } = {}) =>
        outbound.call(
          identity,
          { service: 'graph', method: 'POST', path, body, declaredWrite: true, ...extra },
          opts,
        );
      let requestId: string | undefined;
      if (msg.channel === 'email') {
        const res = await post('/me/sendMail', {
          message: {
            subject: msg.subject ?? '',
            body: { contentType: 'Text', content: msg.message },
            toRecipients: msg.to.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        });
        return res.requestId ? { requestId: res.requestId } : {};
      }
      const content = {
        body: { contentType: 'html', content: html(msg.message).replace(/\n/g, '<br>') },
        ...(msg.subject && msg.channel === 'teamsChannel' ? { subject: msg.subject } : {}),
      };
      for (const target of msg.to) {
        if (msg.channel === 'teamsChannel') {
          const [team, channel] = target.split('/');
          if (!team || !channel)
            throw new StepError(
              'invalid_request',
              `Teams channel targets look like <teamId>/<channelId> (got ${target}).`,
            );
          requestId =
            (
              await post(
                `/teams/${encodePathSegment(team)}/channels/${encodePathSegment(channel)}/messages`,
                content,
              )
            ).requestId ?? requestId;
          continue;
        }
        let chatId = target;
        if (!target.startsWith('19:')) {
          if (!identity.actor.oid)
            throw new StepError('notify_unsupported', 'A one-on-one chat needs the sender’s object id.');
          const member = (who: string) => ({
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            // Percent-encoded (a guest's `#EXT#` must not end the URL), then an OData string literal (`'` doubled,
            // S-31), so a UPN can't close the literal early and append to the reference.
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users(${odataLiteral(encodeURIComponent(who))})`,
          });
          // `chatMembers`: the members are bound by UPN when the step names one, which the protected-object guard
          // otherwise refuses in a write (S-15); a chat is a conversation, not a change to anyone's account.
          const chat = await post(
            '/chats',
            { chatType: 'oneOnOne', members: [member(identity.actor.oid), member(target)] },
            { chatMembers: true },
          );
          chatId = String((chat.data as { id?: unknown } | null)?.id ?? '');
          if (!chatId) throw new StepError('notify_failed', `Could not open a chat with ${target}.`);
        }
        requestId =
          (await post(`/chats/${encodePathSegment(chatId)}/messages`, content)).requestId ?? requestId;
      }
      return requestId ? { requestId } : {};
    },
  };
}
