import { mockConfig } from './helpers';
import { ALL_ROLES, AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

const TAP = 'Tap-Secret-4242-Value';
const USER = '00000000-0000-4000-8000-000000000001';
const base = { owner: 'tests', version: '1.0.0', risk: 'low', mode: 'write' } as const;
const create = {
  id: 'create',
  type: 'graph',
  mode: 'write',
  describe: 'Create a Temporary Access Pass',
  request: { method: 'POST', path: '/users/${ $encode(inputs.userId) }/authentication/temporaryAccessPassMethods', body: { lifetimeInMinutes: 60 } },
  secretOutputs: ['temporaryAccessPass'],
  dryRunOutput: { temporaryAccessPass: 'dry-run-placeholder', lifetimeInMinutes: 60 },
};
const inputs = { userId: { type: 'string', format: 'guid' } };

function definitions() {
  return new StaticDefinitions()
    .add({ kind: 'playbook', id: 'test.tap', title: 'Issue TAP', inputs, steps: [create], outputs: { minutes: '${ steps.create.output.lifetimeInMinutes }' }, ...base } as never)
    .add({ kind: 'playbook', id: 'test.tap-approved', title: 'Issue TAP (approved)', inputs, steps: [{ id: 'ok', type: 'approval' }, create], ...base } as never);
}

async function setup(runs: Record<string, unknown> = {}) {
  const outbound = new FakeExecutor((c) => (c.method === 'POST' ? { id: 'm1', temporaryAccessPass: TAP, lifetimeInMinutes: 60 } : null));
  return runsApp({ config: mockConfig(), definitions: definitions(), outbound, runs });
}

/** Everything the runs feature keeps (rows, events, tasks, audit) as one string. */
function persisted(t: Awaited<ReturnType<typeof setup>>) {
  const repo = t.repository as unknown as { runs: Map<string, unknown>; steps: Map<string, Map<number, unknown>>; events: unknown[]; tasks: Map<string, unknown> };
  return JSON.stringify([[...repo.runs.values()], [...repo.steps.values()].map((m) => [...m.values()]), repo.events, [...repo.tasks.values()], t.audit.rows]);
}

async function openStream(address: string, cookie: string, runId: string) {
  const res = await fetch(`${address}/api/runs/${runId}/events`, { headers: { cookie } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state = { text: '' };
  const until = async (needle: string, ms = 5000) => {
    const stop = Date.now() + ms;
    while (!state.text.includes(needle)) {
      if (Date.now() > stop) throw new Error(`stream never contained ${needle}`);
      const { done, value } = await reader.read();
      if (done) break;
      state.text += decoder.decode(value, { stream: true });
    }
  };
  return { state, until, close: () => reader.cancel().catch(() => undefined) };
}

describe('show-once secrets: live delivery', () => {
  it('goes to the initiator’s open stream only (not the approver’s), without an id, and is never stored', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.tap-approved', inputs: { userId: USER } })).json();
    await t.drain();
    const blake = await t.login(BLAKE, ['Playbook.Approver', 'Portal.Operator'], { armed: true });
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const averyStream = await openStream(address, avery.headers.cookie, runId);
    const blakeStream = await openStream(address, blake.headers.cookie, runId);
    await averyStream.until('"status":"awaiting_approval"');
    await blakeStream.until('"status":"awaiting_approval"');

    expect((await blake.post(`/api/runs/${runId}/approvals/ok`, { decision: 'approve' })).statusCode).toBe(200);
    await averyStream.until('event: end');
    await blakeStream.until('event: end');
    const frame = averyStream.state.text.split('\n\n').find((f) => f.includes('"type":"secret"'))!;
    expect(frame.startsWith('data: ')).toBe(true); // no `id:` line: not replayable
    expect(JSON.parse(frame.slice(6))).toEqual({ type: 'secret', runId, stepId: 'create', stepPath: 'create', values: { temporaryAccessPass: TAP }, hints: { temporaryAccessPass: '…alue' }, producedAt: expect.any(String) });
    expect(blakeStream.state.text).not.toContain(TAP); // the approver executed the step but did not start the run
    // Shown once: a later fetch, or a replay of the event stream, has nothing.
    expect((await avery.get(`/api/runs/${runId}/secret/create`)).statusCode).toBe(404);
    expect((await avery.get(`/api/runs/${runId}/events`)).body).not.toContain(TAP);
    expect((await avery.get(`/api/runs/${runId}`)).json().steps.find((s: { stepId: string }) => s.stepId === 'create').output).toEqual({
      id: 'm1',
      temporaryAccessPass: { $secret: true, hint: '…alue' },
      lifetimeInMinutes: 60,
    });
    expect(persisted(t)).not.toContain(TAP);
    expect(t.audit.rows.filter((r) => r.action === 'run.secret.revealed').map((r) => [r.actorUpn, r.details])).toEqual([
      [AVERY.upn, { stepId: 'create', stepPath: 'create', fields: ['temporaryAccessPass'], channel: 'stream', streams: 1 }],
    ]);
    expect(t.runs.secrets.heldCount).toBe(0);
    await averyStream.close();
    await blakeStream.close();
    await t.close();
  });
});

describe('show-once secrets: fetch once', () => {
  it('without a live stream it is held for the first fetch by the initiator’s session, then gone', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.tap', inputs: { userId: USER } })).json();
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run).toMatchObject({ status: 'succeeded', outputs: { minutes: 60 } });
    // The stored event says a secret is waiting (fields + hints, no value) so the UI knows to fetch it.
    const events = (await avery.get(`/api/runs/${runId}/events`)).body;
    expect(events).toContain('"secret":{"runId"');
    expect(events).toContain('"status":"held"');
    expect(events).not.toContain(TAP);
    expect(t.runs.secrets.heldCount).toBe(1);

    // CSRF header required (a cross-site navigation must not burn it).
    expect((await t.app.inject({ method: 'GET', url: `/api/runs/${runId}/secret/create`, headers: { cookie: avery.headers.cookie } })).statusCode).toBe(403);
    // Another session of the same person, or another person, gets nothing (and does not burn it).
    const averyElsewhere = await t.login(AVERY, ['Portal.Operator']);
    expect((await averyElsewhere.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': averyElsewhere.record.csrf })).statusCode).toBe(404);
    const blake = await t.login(BLAKE, ALL_ROLES);
    const nope = await blake.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': blake.record.csrf });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().error.code).toBe('secret_not_available');

    const first = await avery.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': avery.record.csrf });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toEqual({ type: 'secret', runId, stepId: 'create', stepPath: 'create', values: { temporaryAccessPass: TAP }, hints: { temporaryAccessPass: '…alue' }, producedAt: expect.any(String) });
    expect((await avery.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': avery.record.csrf })).statusCode).toBe(404);
    expect(persisted(t)).not.toContain(TAP);
    expect(t.audit.rows.find((r) => r.action === 'run.secret.revealed')).toMatchObject({ actorUpn: AVERY.upn, details: { channel: 'fetch', fields: ['temporaryAccessPass'] } });
    await t.close();
  });

  it('is dropped after the hold time (audited as expired)', async () => {
    const t = await setup({ secretTtlMs: 30 });
    const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.tap', inputs: { userId: USER } })).json();
    await t.drain();
    await new Promise((r) => setTimeout(r, 80));
    expect(t.runs.secrets.heldCount).toBe(0);
    expect((await avery.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': avery.record.csrf })).statusCode).toBe(404);
    expect(t.audit.rows.find((r) => r.action === 'run.secret.expired')).toMatchObject({ targetId: runId, result: 'failure', details: { fields: ['temporaryAccessPass'] } });
    expect(persisted(t)).not.toContain(TAP);
    await t.close();
  });

  it('dry runs and scheduled runs never produce a deliverable secret', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator']);
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.tap', inputs: { userId: USER }, dryRun: true })).json();
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}/secret/create`, { 'x-adminforge-csrf': avery.record.csrf })).statusCode).toBe(404);
    expect((await avery.get(`/api/runs/${runId}`)).json().steps[0].output).toEqual({ temporaryAccessPass: { $secret: true, hint: '19 characters' }, lifetimeInMinutes: 60 });

    const row = await t.runs.service.createScheduledRun({ schedule: { key: 'test.nightly', createdBy: AVERY.oid, approvedBy: [BLAKE.oid] }, playbook: 'test.tap', inputs: { userId: USER } });
    await t.drain();
    expect((await t.repository.getRun(row.id))!.status).toBe('succeeded');
    expect(t.runs.secrets.heldCount).toBe(0);
    const events = await t.repository.listEvents(row.id, 0, 100);
    expect(events.find((e) => e.data.secret)).toMatchObject({ level: 'warn', data: { secret: { status: 'discarded' } } });
    expect(persisted(t)).not.toContain(TAP);
    await t.close();
  });
});
