import { AppError } from '@adminforge/api/src/errors';
import { mockConfig } from './helpers';
import { AVERY, BLAKE, CASEY, DREW, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';
import { DANA } from './support/people';

// S-25: someone else's delegated run shows its metadata only (playbook, who, when, status, step names and states,
// references). Its initiator, its approvers (asked or decided) and Portal.Admin keep the inputs and results.
// Scheduled runs (automation identity) stay as they were: whoever may open them sees them whole.

const USER = '00000000-0000-4000-8000-000000000001';
/** What the run ran with, found, was told or failed on: none of it may reach a metadata-only viewer. */
const REASON = 'Ticket INC-4242 for a.lee';
const FOUND = 'a.lee@example.com';
const COMMENT = 'Checked with HR, INC-4242';
const FAILURE = 'User a.lee@example.com does not exist in Example Org';
const MARKERS = [REASON, FOUND, COMMENT, FAILURE, 'INC-4242'];

const base = { owner: 'tests', version: '1.0.0' } as const;
const inputs = { userId: { type: 'string', format: 'guid' }, reason: { type: 'string' } };
const lookup = {
  id: 'lookup',
  type: 'graph',
  mode: 'read',
  request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
};

function definitions() {
  return new StaticDefinitions()
    .add({
      kind: 'playbook',
      id: 'test.lookup',
      title: 'Look up a user',
      risk: 'low',
      mode: 'read',
      inputs,
      outputs: { upn: '${ steps.lookup.output.upn }' },
      steps: [lookup],
      ...base,
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.gated',
      title: 'Gated lookup',
      risk: 'low',
      mode: 'read',
      inputs,
      outputs: { upn: '${ steps.lookup.output.upn }' },
      steps: [{ id: 'approve', type: 'approval', message: 'Look up for ${ inputs.reason }?' }, lookup],
      ...base,
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.failing',
      title: 'Failing lookup',
      risk: 'low',
      mode: 'read',
      inputs,
      steps: [{ ...lookup, request: { method: 'GET', path: '/missing/${ $encode(inputs.userId) }' } }],
      ...base,
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.parent',
      title: 'Approved parent',
      risk: 'low',
      mode: 'read',
      inputs,
      steps: [
        { id: 'approve', type: 'approval', message: 'Go?' },
        {
          id: 'child',
          type: 'playbook',
          ref: 'test.lookup',
          inputs: { userId: '${ inputs.userId }', reason: '${ inputs.reason }' },
        },
      ],
      ...base,
    } as never);
}

async function setup(streamPollMs?: number) {
  return runsApp({
    config: mockConfig(),
    definitions: definitions(),
    outbound: new FakeExecutor((c) => {
      if (c.path.startsWith('/missing/'))
        throw new AppError(404, 'not_found', FAILURE, { hint: `Check ${FOUND} in Entra ID.` });
      return { id: USER, upn: FOUND };
    }),
    runs: streamPollMs ? { streamPollMs } : {},
  });
}

const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
const APPROVER = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];

function expectNoData(body: unknown) {
  const text = JSON.stringify(body);
  for (const m of MARKERS) expect(text).not.toContain(m);
}

describe('someone else’s delegated run: metadata only (S-25)', () => {
  it('another Operator sees playbook, who, when, status, steps and references — no inputs, outputs, requests or plan', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.lookup', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();

    const own = (await avery.get(`/api/runs/${runId}`)).json();
    expect(own.run).toMatchObject({
      access: 'full',
      inputs: { userId: USER, reason: REASON },
      outputs: { upn: FOUND },
    });
    expect(own.steps[0].request).toMatchObject({ path: `/users/${USER}` });
    expect(own.steps[0].output).toMatchObject({ upn: FOUND });

    const blake = await t.login(BLAKE, OPERATOR);
    const res = await blake.get(`/api/runs/${runId}`);
    expect(res.statusCode).toBe(200);
    const other = res.json();
    expect(other.run).toMatchObject({
      id: runId,
      access: 'metadata',
      definitionKey: 'test.lookup',
      title: 'Look up a user',
      status: 'succeeded',
      initiatorOid: AVERY.oid,
      initiatorUpn: AVERY.upn,
      correlationId: own.run.correlationId,
      inputs: {},
      outputs: null,
      error: null,
    });
    expect(other.run.startedAt).toBe(own.run.startedAt);
    expect(other.run.endedAt).toBe(own.run.endedAt);
    expect(other.steps).toHaveLength(own.steps.length);
    expect(other.steps[0]).toMatchObject({
      stepId: 'lookup',
      path: 'lookup',
      type: 'graph',
      status: 'succeeded',
      mode: 'read',
      msRequestId: own.steps[0].msRequestId,
      request: null,
      plan: null,
      output: null,
      error: null,
    });
    expect(other.plan).toEqual([]);
    expectNoData(other);
    expect(JSON.stringify(other)).not.toContain(USER);
    await t.close();
  });

  it('a failed run keeps its error code and references, not the message or hint', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.failing', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();
    const own = (await avery.get(`/api/runs/${runId}`)).json();
    expect(own.run.status).toBe('failed');
    expect(own.run.error.message).toContain(FAILURE);

    const other = (await (await t.login(BLAKE, OPERATOR)).get(`/api/runs/${runId}`)).json();
    expect(other.run.status).toBe('failed');
    expect(other.run.error).toMatchObject({ code: own.run.error.code, message: expect.any(String) });
    expect(other.run.error.hint).toBeUndefined();
    const step = other.steps.find((s: { stepId: string }) => s.stepId === 'lookup');
    expect(step.status).toBe('failed');
    expect(step.error).toMatchObject({ code: own.run.error.code });
    expectNoData(other);
    await t.close();
  });

  it('the run stream sends metadata only: status and step events, no logs, no data', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.failing', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();
    const own = (await avery.get(`/api/runs/${runId}/events`)).body;
    expect(own).toContain(FAILURE);

    const blake = await t.login(BLAKE, OPERATOR);
    const sse = await blake.get(`/api/runs/${runId}/events`);
    expect(sse.statusCode).toBe(200);
    expect(sse.body).toContain('"type":"run"');
    expect(sse.body).toContain('"type":"step"');
    // The same events, by id: the browser resumes where it was whoever it is.
    const ids = (body: string) => [...body.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]);
    expect(ids(sse.body)).toEqual(ids(own));
    expect(sse.body).toContain('"error":{"code":"not_found"');
    expect(sse.body.trimEnd().endsWith('event: end\ndata: {"status":"failed"}')).toBe(true);
    for (const m of MARKERS) expect(sse.body).not.toContain(m);
    await t.close();
  });

  it('the run list carries no inputs or outputs for anyone', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR);
    await avery.post('/api/runs', { playbook: 'test.lookup', inputs: { userId: USER, reason: REASON } });
    await t.drain();
    const list = (await (await t.login(BLAKE, OPERATOR)).get('/api/runs?scope=all')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('inputs');
    expect(list.items[0]).not.toHaveProperty('outputs');
    expectNoData(list);
    await t.close();
  });

  it('Portal.Admin keeps the inputs and results', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.lookup', inputs: { userId: USER, reason: REASON } })
    ).json();
    const failed = (
      await avery.post('/api/runs', { playbook: 'test.failing', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();
    const dana = await t.login(DANA, ['Portal.Reader', 'Portal.Admin']);
    expect((await dana.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      access: 'full',
      inputs: { reason: REASON },
      outputs: { upn: FOUND },
    });
    expect((await dana.get(`/api/runs/${failed.runId}`)).json().run.error.message).toContain(FAILURE);
    expect((await dana.get(`/api/runs/${failed.runId}/events`)).body).toContain(FAILURE);
    await t.close();
  });
});

describe('approvers keep the inputs and results of runs they are asked to approve or did approve (S-25)', () => {
  it('asked: full while the gate waits for them; decided: full afterwards; anyone else: metadata', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.gated', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();
    const blake = await t.login(BLAKE, APPROVER);
    const drew = await t.login(DREW, APPROVER);
    const casey = await t.login(CASEY, OPERATOR);

    // Pending: every approver the gate asks sees what they are asked to approve; an Operator doesn't.
    for (const who of [blake, drew]) {
      const d = (await who.get(`/api/runs/${runId}`)).json();
      expect(d.run).toMatchObject({
        status: 'awaiting_approval',
        access: 'full',
        inputs: { reason: REASON },
      });
      expect(d.tasks[0].policy.message).toContain(REASON);
    }
    const waiting = (await casey.get(`/api/runs/${runId}`)).json();
    expect(waiting.run).toMatchObject({ status: 'awaiting_approval', access: 'metadata', inputs: {} });
    expect(waiting.run.waiting).toMatchObject({ kind: 'approval', stepId: 'approve' });
    expect(waiting.tasks[0]).toMatchObject({ kind: 'approval', status: 'pending', canDecide: false });
    expect(waiting.tasks[0].policy.message).toBeNull();
    expectNoData(waiting);

    const decided = await blake.post(`/api/runs/${runId}/approvals/approve`, {
      decision: 'approve',
      comment: COMMENT,
    });
    expect(decided.json()).toMatchObject({ status: 'approved' });
    await t.drain();

    const mine = (await blake.get(`/api/runs/${runId}`)).json();
    expect(mine.run).toMatchObject({ status: 'succeeded', access: 'full', outputs: { upn: FOUND } });
    expect(mine.tasks[0].decisions[0]).toMatchObject({ upn: BLAKE.upn, comment: COMMENT });
    // Drew was asked, but the gate is decided and he took no part: metadata now.
    for (const who of [drew, casey]) {
      const d = (await who.get(`/api/runs/${runId}`)).json();
      expect(d.run).toMatchObject({ status: 'succeeded', access: 'metadata', inputs: {}, outputs: null });
      // Who decided and when stays visible; what they wrote does not.
      expect(d.tasks[0].decisions[0]).toMatchObject({ upn: BLAKE.upn, decision: 'approve' });
      expect(d.tasks[0].decisions[0].comment).toBeUndefined();
      expectNoData(d);
      const sse = (await who.get(`/api/runs/${runId}/events`)).body;
      expect(sse).not.toContain('"type":"log"');
      for (const m of MARKERS) expect(sse).not.toContain(m);
    }
    // The approvals inbox agrees: Blake's decision in full, the gate Drew took no part in as metadata.
    const inbox = async (who: typeof blake) =>
      (await who.get('/api/approvals?status=approved'))
        .json()
        .items.find((i: { subjectId: string }) => i.subjectId === runId);
    expect(await inbox(blake)).toMatchObject({
      policy: { message: expect.stringContaining(REASON) },
      decisions: [{ upn: BLAKE.upn, comment: COMMENT }],
    });
    const drews = await inbox(drew);
    expect(drews).toMatchObject({ status: 'approved', policy: { message: null } });
    expectNoData(drews);
    // The approver's own stream has the log, with what he wrote.
    const his = (await blake.get(`/api/runs/${runId}/events`)).body;
    expect(his).toContain('"type":"log"');
    expect(his).toContain(COMMENT);
    await t.close();
  });

  it('an open stream follows what its viewer may see: a gate decided by someone else stops the data at once', async () => {
    const t = await setup(50);
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.gated', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();
    const blake = await t.login(BLAKE, APPROVER);
    const drew = await t.login(DREW, APPROVER);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/runs/${runId}/events`, {
      headers: { cookie: drew.headers.cookie },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (done: (s: string) => boolean) => {
      const stop = Date.now() + 5000;
      while (!done(text) && Date.now() < stop) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await read((s) => s.includes('"status":"awaiting_approval"'));
    await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve', comment: COMMENT });
    await t.drain();
    await read((s) => s.includes('event: end'));
    // The rest of the run reaches Drew as metadata: its states, not Blake's comment or what the lookup found.
    expect(text).toContain('"status":"succeeded"');
    expect(text).not.toContain('"type":"log"');
    expect(text).not.toContain(COMMENT);
    expect(text).not.toContain(FOUND);
    await reader.cancel().catch(() => undefined);
    await t.close();
  });

  it('a metadata-only stream ends when its viewer may see more, so the reconnect brings what was held back', async () => {
    const t = await setup(50);
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.gated', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();
    const casey = await t.login(CASEY, OPERATOR);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/runs/${runId}/events`, {
      headers: { cookie: casey.headers.cookie },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (needle: string) => {
      const stop = Date.now() + 5000;
      while (!text.includes(needle) && Date.now() < stop) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await read('"status":"awaiting_approval"');
    await t.sessions.update(casey.record.idHash, { roles: [...OPERATOR, 'Portal.Admin'] });
    await read('event: session.ended');
    expect(text).toContain('event: session.ended');
    await reader.cancel().catch(() => undefined);
    await t.close();
  });

  it('the initiator of the parent run sees a child the approver started; a bystander does not', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, OPERATOR);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.parent', inputs: { userId: USER, reason: REASON } })
    ).json();
    await t.drain();
    const blake = await t.login(BLAKE, APPROVER);
    expect(
      (await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode,
    ).toBe(200);
    await t.drain();
    const parent = (await avery.get(`/api/runs/${runId}`)).json();
    expect(parent.run.status).toBe('succeeded');
    const child = parent.children[0];
    // The steps after the approval ran as the approver, so the child run is his.
    expect(child.initiatorOid).toBe(BLAKE.oid);
    expect((await avery.get(`/api/runs/${child.id}`)).json().run).toMatchObject({
      access: 'full',
      inputs: { reason: REASON },
    });
    expect((await blake.get(`/api/runs/${child.id}`)).json().run.access).toBe('full');
    const casey = await t.login(CASEY, OPERATOR);
    const seen = (await casey.get(`/api/runs/${runId}`)).json();
    expect(seen.run.access).toBe('metadata');
    // The child run is still linked from the parent's step, without its output.
    const step = seen.steps.find((s: { stepId: string }) => s.stepId === 'child');
    expect(step).toMatchObject({ output: null, childRunId: child.id });
    expect((await casey.get(`/api/runs/${child.id}`)).json().run.access).toBe('metadata');
    await t.close();
  });
});

describe('scheduled runs (automation identity) are not one person’s data (S-25)', () => {
  it('an Operator who may open a scheduled run sees it whole, as before', async () => {
    const t = await setup();
    const run = await t.runs.service.createScheduledRun({
      schedule: { key: 'ops.nightly', createdBy: 'content (owner: tests)' },
      playbook: 'test.lookup',
      inputs: { userId: USER, reason: REASON },
    });
    await t.drain();
    const blake = await t.login(BLAKE, OPERATOR);
    expect((await blake.get(`/api/runs/${run.id}`)).json().run).toMatchObject({
      identity: 'automation',
      access: 'full',
      inputs: { reason: REASON },
      outputs: { upn: FOUND },
    });
    await t.close();
  });
});
