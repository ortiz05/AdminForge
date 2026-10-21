import { ApiError } from '@adminforge/connectors';
import { createGraphNotifier, type RunnerPort, type ServiceCall } from '@adminforge/engine';
import { APPROVER, FakeOutbound, harness, INITIATOR, playbook } from './helpers';

describe('handlers: service calls', () => {
  it('graph: renders query/headers, refuses content-set Authorization, passes paging', async () => {
    const h = harness(
      playbook([
        {
          id: 'list',
          type: 'graph',
          mode: 'read',
          paging: 'all',
          maxItems: 50,
          request: {
            method: 'GET',
            path: '/users',
            query: {
              $filter: '${ "startswith(displayName," & $odata("O\'B") & ")" }',
              $top: 10,
              $count: true,
              $skip: null,
            },
            headers: { ConsistencyLevel: 'eventual' },
            beta: true,
          },
        },
      ]),
    );
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls[0]!.call).toEqual({
      service: 'graph',
      method: 'GET',
      path: '/users',
      query: { $filter: "startswith(displayName,'O''B')", $top: 10, $count: true },
      headers: { ConsistencyLevel: 'eventual' },
      body: undefined,
      beta: true,
      paging: 'all',
      maxItems: 50,
    });
    // The schema refuses the header at validate time (S-02); a definition published before that still meets the
    // engine's own refusal.
    const def = playbook([
      {
        id: 'x',
        type: 'graph',
        mode: 'read',
        request: { method: 'GET', path: '/me', headers: { Prefer: 'x' } },
      },
    ]);
    (def.steps[0] as { request: { headers: Record<string, string> } }).request.headers = {
      Authorization: 'Bearer x',
    };
    const bad = harness(def);
    expect((await bad.exec()).error).toMatchObject({
      code: 'invalid_request',
      message: 'Header Authorization cannot be set by content.',
    });
  });

  it('graph: a path that does not render to /… is refused', async () => {
    const h = harness(
      playbook([{ id: 'x', type: 'graph', mode: 'read', request: { method: 'GET', path: '${ "users" }' } }]),
    );
    expect((await h.exec()).error).toMatchObject({ code: 'invalid_request' });
    expect(h.outbound.calls).toHaveLength(0);
  });

  it('graphBatch: one $batch call; named outputs; a failing sub-request fails the step (transient when 429/5xx)', async () => {
    const def = playbook([
      {
        id: 'counts',
        type: 'graphBatch',
        mode: 'read',
        retry: { max: 1 },
        requests: {
          users: { method: 'GET', path: '/users/$count', headers: { ConsistencyLevel: 'eventual' } },
          guests: { method: 'GET', path: '/users', query: { $filter: "userType eq 'Guest'" } },
        },
      },
    ]);
    const h = harness(def, {
      respond: () => ({
        responses: [
          { id: 'users', status: 200, body: 42 },
          { id: 'guests', status: 200, body: { value: [] } },
        ],
      }),
    });
    await h.exec();
    expect(h.outbound.calls[0]!.call).toMatchObject({
      service: 'graph',
      method: 'POST',
      path: '/$batch',
      body: {
        requests: [
          { id: 'users', method: 'GET', url: '/users/$count', headers: { ConsistencyLevel: 'eventual' } },
          { id: 'guests', method: 'GET', url: "/users?$filter=userType%20eq%20'Guest'" },
        ],
      },
    });
    expect(h.record('counts')?.output).toEqual({ users: 42, guests: { value: [] } });
    let n = 0;
    const t = harness(def, {
      respond: () => ({
        responses: [
          { id: 'users', status: ++n === 1 ? 429 : 200, body: 1, headers: { 'Retry-After': '3' } },
          { id: 'guests', status: 200, body: 2 },
        ],
      }),
    });
    expect((await t.exec()).status).toBe('succeeded');
    expect(t.clock.sleeps).toEqual([3000]);
  });

  it('arm, resourceGraph, logAnalytics and function render their service calls', async () => {
    const h = harness(
      playbook(
        [
          {
            id: 'rg',
            type: 'arm',
            mode: 'read',
            request: {
              method: 'GET',
              path: '/subscriptions/${ inputs.sub }/resourceGroups',
              apiVersion: '2022-12-01',
            },
            paging: 'all',
          },
          {
            id: 'inv',
            type: 'resourceGraph',
            mode: 'read',
            query: 'resources | take 5',
            subscriptions: '${ [inputs.sub] }',
          },
          {
            id: 'logs',
            type: 'logAnalytics',
            mode: 'read',
            workspace: '${ inputs.ws }',
            query: 'Heartbeat | take 1',
            timespan: 'P1D',
          },
          {
            id: 'fn',
            type: 'function',
            mode: 'read',
            connection: 'connections.hr-sync',
            operation: 'getUser',
            pathParams: { id: '${ inputs.sub }' },
          },
        ],
        { inputs: { sub: { type: 'string' }, ws: { type: 'string' } } },
      ),
      { inputs: { sub: 's1', ws: 'w1' } },
    );
    expect((await h.exec()).status).toBe('succeeded');
    const calls = h.outbound.calls.map((c) => c.call);
    expect(calls[0]).toMatchObject({
      service: 'arm',
      method: 'GET',
      path: '/subscriptions/s1/resourceGroups',
      apiVersion: '2022-12-01',
      paging: 'all',
      poll: true,
    });
    expect(calls[1]).toMatchObject({
      service: 'arm',
      method: 'POST',
      path: '/providers/Microsoft.ResourceGraph/resources',
      apiVersion: '2022-10-01',
      body: { query: 'resources | take 5', subscriptions: ['s1'] },
    });
    expect(calls[2]).toMatchObject({
      service: 'logAnalytics',
      method: 'POST',
      path: '/v1/workspaces/w1/query',
      body: { query: 'Heartbeat | take 1', timespan: 'P1D' },
    });
    expect(calls[3]).toMatchObject({
      service: 'function',
      connection: 'connections.hr-sync',
      operation: 'getUser',
      pathParams: { id: 's1' },
    });
  });

  it('runner: streams events, maps results, and fails without a runner', async () => {
    const jobs: unknown[] = [];
    const runner: RunnerPort = {
      async run(_identity, job, { onEvent }) {
        jobs.push(job);
        await onEvent({ type: 'log', level: 'info', message: 'connecting' });
        await onEvent({ type: 'progress', percent: 50, message: 'half' });
        await onEvent({ type: 'output', data: { forwarding: false } });
        return job.parameters.fail
          ? {
              status: 'failed',
              output: null,
              error: { message: 'Set-Mailbox is not loaded', category: 'readOnly' },
            }
          : { status: 'succeeded', output: { forwarding: false } };
      },
    };
    const step = (fail: boolean) => ({
      id: 'ps',
      type: 'runner',
      mode: 'read',
      script: 'exchange/Get-MailboxForwarding.ps1',
      sha256: 'b'.repeat(64),
      parameters: { identity: 'x@example.com', fail },
      services: ['exchange'],
      timeoutSeconds: 60,
    });
    const ok = harness(playbook([step(false)]), { engine: { runner } });
    expect((await ok.exec()).status).toBe('succeeded');
    expect(ok.record('ps')?.output).toEqual({ forwarding: false });
    expect(jobs[0]).toMatchObject({
      jobId: expect.stringMatching(/^run-1:ps:/),
      script: 'exchange/Get-MailboxForwarding.ps1',
      services: ['exchange'],
      mode: 'read',
      timeoutSeconds: 60,
    });
    expect(ok.store.events.filter((e) => e.type !== 'status').map((e) => [e.type, e.data])).toEqual([
      ['log', { message: 'connecting' }],
      ['progress', { percent: 50, message: 'half' }],
      ['output', { data: { forwarding: false } }],
    ]);
    const ro = harness(playbook([step(true)]), { engine: { runner } });
    expect((await ro.exec()).error).toMatchObject({
      code: 'read_only',
      message: 'Set-Mailbox is not loaded',
    });
    expect((await harness(playbook([step(false)])).exec()).error).toMatchObject({
      code: 'runner_unavailable',
    });
  });

  it('notify: plans as SEND and sends through the notifier as the actor', async () => {
    const sent: unknown[] = [];
    const h = harness(
      playbook(
        [
          {
            id: 'tell',
            type: 'notify',
            mode: 'write',
            describe: 'Tell',
            channel: 'teamsChat',
            to: '${ [inputs.who] }',
            message: 'Hi ${ inputs.who }',
          },
        ],
        { inputs: { who: { type: 'string' } } },
      ),
      {
        inputs: { who: 'c@example.com' },
        engine: {
          notifier: { send: async (identity, msg) => (sent.push({ actor: identity.actor.oid, msg }), {}) },
        },
      },
    );
    expect((await h.exec()).status).toBe('succeeded');
    expect(sent).toEqual([
      {
        actor: INITIATOR.oid,
        msg: { channel: 'teamsChat', to: ['c@example.com'], message: 'Hi c@example.com' },
      },
    ]);
    expect(h.record('tell')?.output).toEqual({ sent: true, channel: 'teamsChat', recipients: 1 });
  });
});

describe('createGraphNotifier', () => {
  const identity = { actor: APPROVER, mode: 'write' as const, handle: null };
  const opts = { correlationId: 'c', signal: new AbortController().signal };

  it('email → /me/sendMail; channel → /teams/{t}/channels/{c}/messages; user → one-on-one chat then message', async () => {
    const out = new FakeOutbound((c: ServiceCall) =>
      c.path === '/chats' ? { id: '19:new@unq.gbl.spaces' } : null,
    );
    const n = createGraphNotifier(out);
    await n.send(identity, { channel: 'email', to: ['a@example.com'], subject: 'S', message: 'M' }, opts);
    await n.send(
      identity,
      {
        channel: 'teamsChannel',
        to: ['team1/19:chan@thread.tacv2'],
        subject: 'S',
        message: '<b>x</b>\nline',
      },
      opts,
    );
    await n.send(
      identity,
      { channel: 'teamsChat', to: ['b@example.com', '19:existing@thread.v2'], message: 'hi' },
      opts,
    );
    expect(out.calls.map((c) => [c.call.method, c.call.path, c.call.declaredWrite])).toEqual([
      ['POST', '/me/sendMail', true],
      ['POST', '/teams/team1/channels/19%3Achan%40thread.tacv2/messages', true],
      ['POST', '/chats', true],
      ['POST', '/chats/19%3Anew%40unq.gbl.spaces/messages', true],
      ['POST', '/chats/19%3Aexisting%40thread.v2/messages', true],
    ]);
    expect(out.calls[0]!.call.body).toEqual({
      message: {
        subject: 'S',
        body: { contentType: 'Text', content: 'M' },
        toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
      },
      saveToSentItems: true,
    });
    expect(out.calls[1]!.call.body).toEqual({
      body: { contentType: 'html', content: '&lt;b&gt;x&lt;/b&gt;<br>line' },
      subject: 'S',
    });
    expect(
      (out.calls[2]!.call.body as { members: Array<Record<string, string>> }).members.map(
        (m) => m['user@odata.bind'],
      ),
    ).toEqual([
      `https://graph.microsoft.com/v1.0/users('${APPROVER.oid}')`,
      // An OData string literal (S-31), not percent-encoding.
      "https://graph.microsoft.com/v1.0/users('b@example.com')",
    ]);
  });

  it('refuses automation identities and malformed channel targets', async () => {
    const n = createGraphNotifier(new FakeOutbound());
    await expect(
      n.send(
        { actor: { kind: 'automation', oid: 'automation', upn: null }, mode: 'write', handle: null },
        { channel: 'email', to: ['a@example.com'], message: 'x' },
        opts,
      ),
    ).rejects.toMatchObject({ code: 'notify_unsupported' });
    await expect(
      n.send(identity, { channel: 'teamsChannel', to: ['nochannel'], message: 'x' }, opts),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('propagates Graph failures', async () => {
    const n = createGraphNotifier(
      new FakeOutbound(() => {
        throw new ApiError(403, 'Forbidden', 'no Mail.Send');
      }),
    );
    await expect(
      n.send(identity, { channel: 'email', to: ['a@example.com'], message: 'x' }, opts),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
