import { ApiError } from '@adminforge/connectors';
import { mockConfig } from './helpers';
import {
  ALL_ROLES,
  AVERY,
  BLAKE,
  CASEY,
  DREW,
  FakeExecutor,
  runsApp,
  StaticDefinitions,
} from './runs-helpers';

const USER = '00000000-0000-4000-8000-000000000001';

const base = { owner: 'tests', version: '1.0.0' } as const;
const lookup = {
  id: 'lookup',
  type: 'graph',
  mode: 'read',
  request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
};
const disable = {
  id: 'disable',
  type: 'graph',
  mode: 'write',
  describe: 'Disable sign-in',
  request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } },
  dryRunOutput: { done: true },
};
const revoke = {
  id: 'revoke',
  type: 'graph',
  mode: 'write',
  describe: 'Revoke sessions',
  request: { method: 'POST', path: '/users/${ $encode(inputs.userId) }/revokeSignInSessions' },
};
const userInputs = {
  userId: { type: 'string', format: 'guid' },
  secret: { type: 'string', required: false, redact: true },
};

function definitions() {
  return new StaticDefinitions()
    .add({
      kind: 'playbook',
      id: 'test.disable',
      title: 'Disable sign-in',
      risk: 'low',
      mode: 'write',
      inputs: userInputs,
      steps: [lookup, disable, revoke],
      outputs: { upn: '${ steps.lookup.output.upn }' },
      ...base,
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.read-only',
      title: 'Read only',
      risk: 'low',
      mode: 'read',
      requires: { portalRoles: ['Portal.Reader'] },
      inputs: userInputs,
      steps: [lookup],
      ...base,
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.approved',
      title: 'Approved disable',
      risk: 'low',
      mode: 'write',
      inputs: userInputs,
      steps: [
        lookup,
        { id: 'approve', type: 'approval', message: 'Disable ${ steps.lookup.output.upn }?' },
        disable,
      ],
      ...base,
    } as never)
    .add({
      kind: 'runbook',
      id: 'test.runbook',
      title: 'Guided',
      risk: 'low',
      mode: 'write',
      sections: [
        {
          id: 's1',
          title: 'Check',
          body: 'Look',
          steps: [
            {
              id: 'confirm',
              type: 'manual',
              instructions: 'Call the user',
              inputs: { ticket: { type: 'string' } },
            },
            { id: 'echo', type: 'transform', expression: '${ steps.confirm.output.values.ticket }' },
          ],
        },
      ],
      ...base,
    } as never);
}

async function setup(respond?: ConstructorParameters<typeof FakeExecutor>[0]) {
  const t = await runsApp({
    config: mockConfig(),
    definitions: definitions(),
    outbound: new FakeExecutor(
      respond ?? ((c) => (c.method === 'GET' ? { id: USER, upn: 'a.lee@example.com' } : null)),
    ),
  });
  return t;
}

describe('POST /api/runs', () => {
  it('a Reader may dry-run a write playbook: reads run, writes are planned, nothing is written', async () => {
    const t = await setup();
    const reader = await t.login(CASEY, ['Portal.Reader']);
    const res = await reader.post('/api/runs', {
      playbook: 'test.disable',
      inputs: { userId: USER, secret: 'Hunter2-Secret' },
      dryRun: true,
    });
    expect(res.statusCode).toBe(202);
    const { runId, status } = res.json();
    expect(status).toBe('queued');
    await t.drain();
    const detail = (await reader.get(`/api/runs/${runId}`)).json();
    expect(Object.keys(detail).sort()).toEqual(['children', 'plan', 'run', 'steps', 'tasks']);
    expect(detail.run).toMatchObject({
      id: runId,
      status: 'succeeded',
      dryRun: true,
      title: 'Disable sign-in',
      trigger: 'interactive',
      identity: 'delegated',
      initiatorUpn: CASEY.upn,
      outputs: { upn: 'a.lee@example.com' },
    });
    expect(detail.run.inputs).toEqual({ userId: USER, secret: '[redacted]' });
    expect(
      detail.plan.map((p: { stepId: string; method: string; path: string }) => [p.stepId, p.method, p.path]),
    ).toEqual([
      ['disable', 'PATCH', `/users/${USER}`],
      ['revoke', 'POST', `/users/${USER}/revokeSignInSessions`],
    ]);
    expect(detail.steps.map((s: { stepId: string; status: string }) => [s.stepId, s.status])).toEqual([
      ['lookup', 'succeeded'],
      ['disable', 'planned'],
      ['revoke', 'planned'],
    ]);
    expect(Object.keys(detail.steps[0]).sort()).toEqual([
      'actorOid',
      'attempt',
      'endedAt',
      'error',
      'mode',
      'msRequestId',
      'output',
      'path',
      'plan',
      'request',
      'seq',
      'startedAt',
      'status',
      'stepId',
      'type',
    ]);
    expect(t.outbound.calls.map((c) => [c.call.method, c.mode, c.user])).toEqual([
      ['GET', 'read', CASEY.upn],
    ]);
    expect(t.audit.rows.map((r) => r.action)).toEqual(['run.created', 'run.completed']);
    expect(JSON.stringify(t.audit.rows)).not.toContain('Hunter2-Secret');
    await t.close();
  });

  it('executing a write playbook needs Portal.Operator; definition roles are enforced too', async () => {
    const t = await setup();
    const reader = await t.login(CASEY, ['Portal.Reader']);
    const denied = await reader.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: 'forbidden',
      message: 'Running Disable sign-in needs the Portal.Operator role.',
    });
    const operator = await t.login(DREW, ['Portal.Operator']);
    const readOnly = await operator.post('/api/runs', {
      playbook: 'test.read-only',
      inputs: { userId: USER },
    });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().error.message).toMatch(/Portal.Reader/);
    await t.close();
  });

  it('validates inputs, refuses unknown playbooks, and needs CSRF', async () => {
    const t = await setup();
    const op = await t.login(AVERY, ALL_ROLES, { armed: true });
    const bad = await op.post('/api/runs', {
      playbook: 'test.disable',
      inputs: { userId: 'nope', extra: 1 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: 'invalid_inputs',
      message: 'The inputs are not valid. inputs.extra: Unknown input.; inputs.userId: Expected a GUID.',
    });
    expect((await op.post('/api/runs', { playbook: 'test.missing', inputs: {} })).statusCode).toBe(404);
    expect((await op.post('/api/runs', { inputs: {} })).statusCode).toBe(400);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { cookie: op.headers.cookie },
      payload: { playbook: 'test.disable', inputs: { userId: USER } },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/runs' })).statusCode).toBe(401);
    await t.close();
  });

  it('an unarmed Operator: read steps run, the first write parks awaiting_arm; arming + resume finishes it as them', async () => {
    const t = await setup();
    const op = await t.login(AVERY, ['Portal.Operator']);
    const { runId } = (
      await op.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    let detail = (await op.get(`/api/runs/${runId}`)).json();
    expect(detail.run).toMatchObject({
      status: 'awaiting_arm',
      waiting: { kind: 'arm', stepId: 'disable', path: 'disable' },
    });
    await op.arm();
    const resumed = await op.post(`/api/runs/${runId}/resume`);
    expect(resumed.statusCode).toBe(202);
    await t.drain();
    detail = (await op.get(`/api/runs/${runId}`)).json();
    expect(detail.run.status).toBe('succeeded');
    expect(
      t.outbound.calls.map((c) => [c.call.method, c.mode, c.user, c.call.declaredWrite ?? false]),
    ).toEqual([
      ['GET', 'read', AVERY.upn, false],
      ['PATCH', 'write', AVERY.upn, true],
      ['POST', 'write', AVERY.upn, true],
    ]);
    const writes = t.audit.rows.filter((r) => r.action === 'run.step.write');
    expect(
      writes.map((r) => [r.actorUpn, r.mode, (r.details as { stepId: string }).stepId, r.result]),
    ).toEqual([
      [AVERY.upn, 'write', 'disable', 'success'],
      [AVERY.upn, 'write', 'revoke', 'success'],
    ]);
    expect(writes[0]!.details).toMatchObject({
      request: { method: 'PATCH', path: `/users/${USER}`, body: { accountEnabled: false } },
      requestId: 'req-2',
    });
    expect(t.audit.rows.map((r) => r.action)).toEqual([
      'run.created',
      'run.resumed',
      'run.step.write',
      'run.step.write',
      'run.completed',
    ]);
    expect((await t.audit.verify()).ok).toBe(true);
    await t.close();
  });

  it('a lost session parks awaiting_reauth; resuming from a new session rebinds the run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await setup(async (c) => {
      if (c.method === 'GET') await gate;
      return { upn: 'x@example.com' };
    });
    const first = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const { runId } = (
      await first.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await new Promise((r) => setTimeout(r, 20));
    await t.sessions.delete(first.record.idHash); // signed out while the lookup is in flight
    release();
    await t.drain();
    const second = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    expect((await second.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      status: 'awaiting_reauth',
      waiting: { kind: 'reauth', stepId: 'disable' },
    });
    const outsider = await t.login(DREW, ['Portal.Operator']);
    expect((await outsider.post(`/api/runs/${runId}/resume`)).statusCode).toBe(403);
    expect((await second.post(`/api/runs/${runId}/resume`)).statusCode).toBe(202);
    await t.drain();
    expect((await second.get(`/api/runs/${runId}`)).json().run.status).toBe('succeeded');
    expect((await t.repository.getRun(runId))!.sessionHash).toBe(second.record.idHash);
    expect(t.audit.rows.find((r) => r.action === 'run.resumed')?.details).toMatchObject({
      sessionsRebound: 1,
    });
    await t.close();
  });

  it('a failing step fails the run with the upstream error', async () => {
    const t = await setup((c) => {
      if (c.method === 'PATCH')
        throw new ApiError(403, 'Authorization_RequestDenied', 'Insufficient privileges', 'req-x');
      return { upn: 'x@example.com' };
    });
    const op = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const { runId } = (
      await op.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER } })
    ).json();
    await t.drain();
    const run = (await op.get(`/api/runs/${runId}`)).json().run;
    expect(run).toMatchObject({
      status: 'failed',
      error: { code: 'Authorization_RequestDenied', stepId: 'disable', status: 403, requestId: 'req-x' },
    });
    expect(t.audit.rows.find((r) => r.action === 'run.step.write')).toMatchObject({ result: 'failure' });
    await t.close();
  });
});

describe('approvals', () => {
  async function parked() {
    const t = await setup();
    const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.approved', inputs: { userId: USER } })
    ).json();
    await t.drain();
    return { t, avery, runId };
  }

  it('parks for approval; the inbox lists it; the approver (armed, not the initiator) approves and later steps run as them', async () => {
    const { t, avery, runId } = await parked();
    expect((await avery.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      status: 'awaiting_approval',
      waiting: { kind: 'approval', stepId: 'approve' },
    });
    const blake = await t.login(BLAKE, ['Playbook.Approver']);
    const inbox = (await blake.get('/api/approvals?status=pending')).json();
    expect(inbox.items).toEqual([
      expect.objectContaining({
        subjectType: 'run',
        subjectId: runId,
        stepId: 'approve',
        kind: 'approval',
        title: 'Approved disable',
        status: 'pending',
        requestedBy: AVERY.upn,
        expiresAt: null,
        canDecide: true,
        policy: expect.objectContaining({
          message: 'Disable a.lee@example.com?',
          approvers: ['Playbook.Approver'],
          minApprovals: 1,
          writesAfter: true,
          definitionKey: 'test.approved',
        }),
      }),
    ]);
    // Four eyes: the initiator cannot approve their own run.
    const own = await avery.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' });
    expect(own.statusCode).toBe(403);
    expect(own.json().error.code).toBe('own_run');
    expect((await avery.get('/api/approvals?status=pending')).json().items[0].canDecide).toBe(false);
    // Remaining steps write → the approver must be armed.
    const unarmed = await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' });
    expect(unarmed.statusCode).toBe(403);
    expect(unarmed.json().error).toMatchObject({
      code: 'not_armed',
      hint: 'Arm write access, then approve.',
    });
    await blake.arm();
    const ok = await blake.post(`/api/runs/${runId}/approvals/approve`, {
      decision: 'approve',
      comment: 'Confirmed with the SOC',
    });
    expect(ok.json()).toEqual({ status: 'approved', approvals: 1, required: 1 });
    expect(
      (await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode,
    ).toBe(409);
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run.status).toBe('succeeded');
    expect(t.outbound.calls.map((c) => [c.call.method, c.user, c.mode])).toEqual([
      ['GET', AVERY.upn, 'read'],
      ['PATCH', BLAKE.upn, 'write'],
    ]);
    expect(
      detail.steps.find(
        (s: { stepId: string; status: string }) => s.stepId === 'disable' && s.status === 'succeeded',
      ).actorOid,
    ).toBe(BLAKE.oid);
    expect(detail.tasks[0]).toMatchObject({
      status: 'approved',
      decisions: [{ oid: BLAKE.oid, upn: BLAKE.upn, decision: 'approve', comment: 'Confirmed with the SOC' }],
    });
    expect(JSON.stringify(detail)).not.toContain('sessionHash');
    expect(t.audit.rows.find((r) => r.action === 'run.approved')).toMatchObject({
      actorUpn: BLAKE.upn,
      targetId: runId,
    });
    expect(t.audit.rows.find((r) => r.action === 'run.step.write')).toMatchObject({ actorUpn: BLAKE.upn });
    await t.close();
  });

  it('only Playbook.Approver holders see the inbox and decide', async () => {
    const { t, runId } = await parked();
    const op = await t.login(DREW, ['Portal.Operator'], { armed: true });
    expect((await op.get('/api/approvals?status=pending')).statusCode).toBe(403);
    expect((await op.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode).toBe(
      403,
    );
    expect((await op.post(`/api/runs/${runId}/approvals/nope`, { decision: 'approve' })).statusCode).toBe(
      403,
    );
    const blake = await t.login(BLAKE, ['Playbook.Approver']);
    expect((await blake.post(`/api/runs/${runId}/approvals/nope`, { decision: 'approve' })).statusCode).toBe(
      404,
    );
    expect((await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'maybe' })).statusCode).toBe(
      400,
    );
    await t.close();
  });

  it('a rejection fails the run', async () => {
    const { t, avery, runId } = await parked();
    const blake = await t.login(BLAKE, ['Playbook.Approver']);
    expect(
      (
        await blake.post(`/api/runs/${runId}/approvals/approve`, {
          decision: 'reject',
          comment: 'Wrong user',
        })
      ).json().status,
    ).toBe('rejected');
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      status: 'failed',
      error: { code: 'approval_rejected', message: `Rejected by ${BLAKE.upn}: Wrong user` },
    });
    expect(t.audit.rows.map((r) => r.action)).toContain('run.rejected');
    await t.close();
  });

  it('cancelling a parked run cancels its approval; cancelling again is a 409', async () => {
    const { t, avery, runId } = await parked();
    const other = await t.login(DREW, ['Portal.Operator']);
    expect((await other.post(`/api/runs/${runId}/cancel`)).statusCode).toBe(403);
    const res = await avery.post(`/api/runs/${runId}/cancel`);
    expect(res.json()).toEqual({ runId, status: 'cancelled' });
    expect((await avery.post(`/api/runs/${runId}/cancel`)).statusCode).toBe(409);
    const blake = await t.login(BLAKE, ['Playbook.Approver']);
    expect((await blake.get('/api/approvals?status=pending')).json().items).toEqual([]);
    expect((await blake.get('/api/approvals?status=cancelled')).json().items).toHaveLength(1);
    expect(t.audit.rows.map((r) => r.action)).toEqual(['run.created', 'run.completed', 'run.cancelled']);
    await t.close();
  });
});

describe('manual steps (runbooks)', () => {
  it('parks awaiting_input; the initiator confirms with values and the run continues', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator']);
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.runbook', inputs: {} })).json();
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run).toMatchObject({
      kind: 'runbook',
      status: 'awaiting_input',
      waiting: { kind: 'manual', stepId: 'confirm' },
    });
    expect(
      (await avery.post(`/api/runs/${runId}/manual/confirm`, { confirmed: true, values: { ticket: 42 } }))
        .statusCode,
    ).toBe(400);
    const outsider = await t.login(CASEY, ['Portal.Reader']);
    expect((await outsider.post(`/api/runs/${runId}/manual/confirm`, { confirmed: true })).statusCode).toBe(
      404,
    );
    expect(
      (
        await avery.post(`/api/runs/${runId}/manual/confirm`, {
          confirmed: true,
          notes: 'Called them',
          values: { ticket: 'INC-7' },
        })
      ).json(),
    ).toEqual({ status: 'approved' });
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run.status).toBe('succeeded');
    expect(detail.steps.at(-1)).toMatchObject({ stepId: 'echo', output: 'INC-7' });
    expect(t.audit.rows.map((r) => r.action)).toContain('run.manual.confirmed');
    await t.close();
  });
});

describe('GET /api/runs', () => {
  it('lists my runs by default; all needs Operator/Approver/Admin; filters by status/playbook; pages with a cursor', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
    const casey = await t.login(CASEY, ['Portal.Reader']);
    for (let i = 0; i < 3; i++) {
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER }, dryRun: true });
      t.clock.advance(1000);
    }
    await casey.post('/api/runs', { playbook: 'test.approved', inputs: { userId: USER }, dryRun: true });
    await t.drain();
    const mine = (await avery.get('/api/runs')).json();
    expect(mine.items).toHaveLength(3);
    expect(mine.items[0]).toEqual(
      expect.objectContaining({
        kind: 'playbook',
        definitionKey: 'test.disable',
        definitionVersion: '1.0.0',
        title: 'Disable sign-in',
        status: 'succeeded',
        dryRun: true,
        trigger: 'interactive',
        identity: 'delegated',
        initiatorUpn: AVERY.upn,
      }),
    );
    expect((await casey.get('/api/runs?scope=all')).statusCode).toBe(403);
    expect((await avery.get('/api/runs?scope=all')).json().items).toHaveLength(4);
    expect((await avery.get('/api/runs?scope=all&playbook=test.approved')).json().items).toHaveLength(1);
    expect((await avery.get('/api/runs?status=active')).json().items).toHaveLength(0);
    expect((await avery.get('/api/runs?status=succeeded,failed')).json().items).toHaveLength(3);
    expect((await avery.get('/api/runs?status=bogus')).statusCode).toBe(400);
    const page1 = (await avery.get('/api/runs?limit=2')).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (await avery.get(`/api/runs?limit=2&cursor=${page1.cursor}`)).json();
    expect(page2.items).toHaveLength(1);
    expect(page2.cursor).toBeUndefined();
    expect(new Set([...page1.items, ...page2.items].map((r: { id: string }) => r.id)).size).toBe(3);
    // Casey cannot read Avery's run.
    expect((await casey.get(`/api/runs/${mine.items[0].id}`)).statusCode).toBe(404);
    expect((await casey.get('/api/runs/not-a-uuid')).statusCode).toBe(404);
    await t.close();
  });
});

describe('GET /api/runs/:id/events (SSE)', () => {
  it('replays events with ids, ends with `end`, and resumes after Last-Event-ID', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader']);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.disable', inputs: { userId: USER }, dryRun: true })
    ).json();
    await t.drain();
    const res = await avery.get(`/api/runs/${runId}/events`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const frames = res.body.split('\n\n').filter((f) => f.startsWith('id:'));
    const events = frames.map((f) => ({
      id: Number(/^id: (\d+)/.exec(f)![1]),
      data: JSON.parse(/\ndata: (.*)$/s.exec(f)![1]!),
    }));
    expect(events[0]!.data).toMatchObject({ type: 'run', data: { scope: 'run', status: 'running' } });
    expect(events.at(-1)!.data).toMatchObject({ type: 'run', data: { status: 'succeeded' } });
    expect(events.map((e) => e.data.type)).toContain('step');
    expect(events.find((e) => e.data.type === 'step')!.data).toMatchObject({
      id: expect.any(Number),
      ts: expect.any(String),
      data: { path: 'lookup', stepId: 'lookup', status: 'running' },
    });
    expect(res.body.trimEnd().endsWith('event: end\ndata: {"status":"succeeded"}')).toBe(true);
    const later = await avery.get(`/api/runs/${runId}/events`, {
      'last-event-id': String(events.at(-2)!.id),
    });
    expect(later.body.split('\n\n').filter((f) => f.startsWith('id:'))).toHaveLength(1);
    const casey = await t.login(CASEY, ['Portal.Reader']);
    expect((await casey.get(`/api/runs/${runId}/events`)).statusCode).toBe(404);
    await t.close();
  });
});

describe('GET /api/runs/:id/events (live)', () => {
  it('streams new events as they happen over a real connection and ends when the run finishes', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.approved', inputs: { userId: USER } })
    ).json();
    await t.drain();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/runs/${runId}/events`, {
      headers: { cookie: avery.headers.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      const until = Date.now() + 5000;
      while (!text.includes(needle)) {
        if (Date.now() > until) throw new Error(`stream never contained ${needle}: ${text}`);
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('"status":"awaiting_approval"');
    expect(text).not.toContain('event: end');
    const blake = await t.login(BLAKE, ['Playbook.Approver'], { armed: true });
    expect(
      (await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode,
    ).toBe(200);
    await readUntil('event: end');
    expect(text).toContain('Approved by blake@example.com');
    expect(text).toContain('"status":"succeeded"');
    await reader.cancel().catch(() => undefined);
    await t.close();
  });
});

describe('bulk actions', () => {
  it('one parent run with a child run per item (inputsTemplate merged under each item)', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const users = [
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000013',
    ];
    const res = await avery.post('/api/runs/bulk', {
      playbook: 'test.disable',
      items: users.map((userId) => ({ userId })),
      inputsTemplate: { secret: 'shared-secret-value' },
      concurrency: 2,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued', items: 3 });
    const { runId } = res.json();
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run).toMatchObject({
      trigger: 'bulk',
      status: 'succeeded',
      title: 'Disable sign-in (bulk)',
      outputs: { total: 3, succeeded: 3, failed: 0 },
    });
    expect(detail.run.inputs.items).toEqual(users.map((userId) => ({ userId, secret: '[redacted]' })));
    expect(detail.children).toHaveLength(3);
    expect(
      detail.children.every(
        (c: { trigger: string; status: string; parentRunId: string }) =>
          c.trigger === 'child' && c.status === 'succeeded' && c.parentRunId === runId,
      ),
    ).toBe(true);
    expect(
      t.outbound.calls
        .filter((c) => c.call.method === 'PATCH')
        .map((c) => c.call.path)
        .sort(),
    ).toEqual(users.map((u) => `/users/${u}`));
    expect((await avery.get(`/api/runs?parent=${runId}`)).json().items).toHaveLength(3);
    // Top-level listing shows only the parent.
    expect((await avery.get('/api/runs')).json().items.map((r: { id: string }) => r.id)).toEqual([runId]);
    const child = (await avery.get(`/api/runs/${detail.children[0].id}`)).json();
    expect(child.run).toMatchObject({ parentRunId: runId, inputs: { secret: '[redacted]' } });
    await t.close();
  });

  it('a bulk dry run plans each item’s writes', async () => {
    const t = await setup();
    const reader = await t.login(CASEY, ['Portal.Reader']);
    const { runId } = (
      await reader.post('/api/runs/bulk', {
        playbook: 'test.disable',
        items: [{ userId: USER }],
        dryRun: true,
      })
    ).json();
    await t.drain();
    const detail = (await reader.get(`/api/runs/${runId}`)).json();
    expect(detail.run.status).toBe('succeeded');
    expect(detail.plan.map((p: { stepPath: string; method: string }) => [p.stepPath, p.method])).toEqual([
      ['items[0].run', 'RUN'],
      ['items[0].run>disable', 'PATCH'],
      ['items[0].run>revoke', 'POST'],
    ]);
    expect(t.outbound.calls.map((c) => c.call.method)).toEqual(['GET']);
    await t.close();
  });

  it('an approval inside a child run parks the parent; approving the child resumes the whole tree as the approver', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
    const { runId } = (
      await avery.post('/api/runs/bulk', { playbook: 'test.approved', items: [{ userId: USER }] })
    ).json();
    await t.drain();
    const parent = (await avery.get(`/api/runs/${runId}`)).json();
    expect(parent.run).toMatchObject({
      status: 'awaiting_approval',
      waiting: { kind: 'child', path: 'items[0].run' },
    });
    const childId = parent.children[0].id;
    expect(parent.children[0].status).toBe('awaiting_approval');
    const blake = await t.login(BLAKE, ['Playbook.Approver'], { armed: true });
    const inbox = (await blake.get('/api/approvals?status=pending')).json().items;
    expect(inbox).toEqual([
      expect.objectContaining({
        subjectId: childId,
        stepId: 'approve',
        title: 'Approved disable',
        canDecide: true,
      }),
    ]);
    expect(
      (await avery.post(`/api/runs/${childId}/approvals/approve`, { decision: 'approve' })).json().error.code,
    ).toBe('own_run');
    expect(
      (await blake.post(`/api/runs/${childId}/approvals/approve`, { decision: 'approve' })).json().status,
    ).toBe('approved');
    await t.drain();
    const done = (await avery.get(`/api/runs/${runId}`)).json();
    expect(done.run).toMatchObject({ status: 'succeeded', outputs: { total: 1, succeeded: 1, failed: 0 } });
    expect(done.children[0].status).toBe('succeeded');
    expect(t.outbound.calls.map((c) => [c.call.method, c.user])).toEqual([
      ['GET', AVERY.upn],
      ['PATCH', BLAKE.upn],
    ]);
    await t.close();
  });

  it('rejects invalid items up front, naming them', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator']);
    const res = await avery.post('/api/runs/bulk', {
      playbook: 'test.disable',
      items: [{ userId: USER }, { userId: 'x' }],
      inputsTemplate: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Some items are not valid. items[1].userId: Expected a GUID.');
    expect((await avery.post('/api/runs/bulk', { playbook: 'test.disable', items: [] })).statusCode).toBe(
      400,
    );
    await t.close();
  });
});

describe('RunService.createScheduledRun (ADR-011)', () => {
  it('runs as the automation identity; write playbooks need the schedule’s second approval', async () => {
    const t = await setup();
    const schedule = {
      id: '00000000-0000-4000-8000-00000000f001',
      key: 'maintenance.nightly-disable',
      createdBy: AVERY.oid,
    };
    await expect(
      t.runs.service.createScheduledRun({ schedule, playbook: 'test.disable', inputs: { userId: USER } }),
    ).rejects.toMatchObject({ status: 403, code: 'two_person_required' });
    const row = await t.runs.service.createScheduledRun({
      schedule: { ...schedule, approvedBy: [BLAKE.oid] },
      playbook: { ref: 'test.disable', version: '1.0.0' },
      inputs: { userId: USER },
    });
    expect(row).toMatchObject({
      trigger: 'schedule',
      identity: 'automation',
      initiatorOid: AVERY.oid,
      sessionHash: null,
      scheduleId: schedule.id,
    });
    await t.drain();
    expect((await t.repository.getRun(row.id))!.status).toBe('succeeded');
    expect(t.outbound.calls.map((c) => [c.kind, c.mode])).toEqual([
      ['automation', 'read'],
      ['automation', 'write'],
      ['automation', 'write'],
    ]);
    const created = t.audit.rows.find((r) => r.action === 'run.created')!;
    expect(created).toMatchObject({
      actorOid: 'automation',
      actorUpn: 'automation identity',
      details: {
        scheduledBy: AVERY.oid,
        executedAs: 'automation identity',
        schedule: schedule.key,
        approvedBy: [BLAKE.oid],
      },
    });
    expect(t.audit.rows.find((r) => r.action === 'run.step.write')).toMatchObject({
      actorOid: 'automation',
      details: { executedAs: 'automation identity', scheduledBy: AVERY.oid },
    });
    // Read-only playbooks need no approval; dry runs neither.
    await expect(
      t.runs.service.createScheduledRun({ schedule, playbook: 'test.read-only', inputs: { userId: USER } }),
    ).resolves.toMatchObject({ identity: 'automation' });
    await expect(
      t.runs.service.createScheduledRun({
        schedule,
        playbook: 'test.disable',
        inputs: { userId: USER },
        dryRun: true,
      }),
    ).resolves.toMatchObject({ dryRun: true });
    await t.close();
  });
});
