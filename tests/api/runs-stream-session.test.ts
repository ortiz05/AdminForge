import { mockConfig } from './helpers';
import { AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// APP-02: an open run stream re-checks its session (sign-out, expiry, idle) and access, like GET /api/events, and a
// show-once secret is never written to the stream of a session that has ended.
const TAP = 'Tap-Secret-7777-Value';
const USER = '00000000-0000-4000-8000-000000000001';
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
const APPROVER = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];

function definitions() {
  return new StaticDefinitions().add({
    kind: 'playbook',
    id: 'test.tap-approved',
    title: 'Issue TAP (approved)',
    owner: 'tests',
    version: '1.0.0',
    risk: 'low',
    mode: 'write',
    inputs: { userId: { type: 'string', format: 'guid' } },
    steps: [
      { id: 'ok', type: 'approval' },
      {
        id: 'create',
        type: 'graph',
        mode: 'write',
        describe: 'Create a Temporary Access Pass',
        request: {
          method: 'POST',
          path: '/users/${ $encode(inputs.userId) }/authentication/temporaryAccessPassMethods',
          body: { lifetimeInMinutes: 60 },
        },
        secretOutputs: ['temporaryAccessPass'],
      },
    ],
  } as never);
}

async function setup(streamPollMs?: number) {
  const outbound = new FakeExecutor((c) =>
    c.method === 'POST' ? { id: 'm1', temporaryAccessPass: TAP, lifetimeInMinutes: 60 } : null,
  );
  return runsApp({
    config: mockConfig(),
    definitions: definitions(),
    outbound,
    runs: streamPollMs ? { streamPollMs } : {},
  });
}

async function openStream(address: string, cookie: string, runId: string) {
  const res = await fetch(`${address}/api/runs/${runId}/events`, { headers: { cookie } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state = { text: '', done: false };
  /** Reads until `needle` shows up (or, with null, until the server closes the stream). */
  const until = async (needle: string | null, ms = 5000) => {
    const stop = Date.now() + ms;
    while (needle === null ? !state.done : !state.text.includes(needle)) {
      if (Date.now() > stop) throw new Error(`stream never contained ${needle ?? 'its end'}`);
      const { done, value } = await reader.read();
      if (done) {
        state.done = true;
        break;
      }
      state.text += decoder.decode(value, { stream: true });
    }
  };
  return { state, until, close: () => reader.cancel().catch(() => undefined) };
}

async function parkedRun(t: Awaited<ReturnType<typeof setup>>) {
  const avery = await t.login(AVERY, OPERATOR, { armed: true });
  const { runId } = (
    await avery.post('/api/runs', { playbook: 'test.tap-approved', inputs: { userId: USER } })
  ).json();
  await t.drain();
  const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
  return { avery, runId, address };
}

describe('run streams follow the session (APP-02)', () => {
  it('signing out ends an open run stream', async () => {
    const t = await setup(50);
    const { avery, runId, address } = await parkedRun(t);
    const stream = await openStream(address, avery.headers.cookie, runId);
    await stream.until('"status":"awaiting_approval"');
    await t.sessions.delete(avery.record.idHash);
    await stream.until(null);
    expect(stream.state.text).toContain('event: session.ended');
    expect(stream.state.text).not.toContain('event: end');
    await t.close();
  });

  it('losing the role to see the run ends a watcher’s stream; the initiator’s stays open', async () => {
    const t = await setup(50);
    const { avery, runId, address } = await parkedRun(t);
    const blake = await t.login(BLAKE, APPROVER);
    const averyStream = await openStream(address, avery.headers.cookie, runId);
    const blakeStream = await openStream(address, blake.headers.cookie, runId);
    await blakeStream.until('"status":"awaiting_approval"');
    await averyStream.until('"status":"awaiting_approval"');
    await t.sessions.update(blake.record.idHash, { roles: ['Portal.Reader'] });
    await blakeStream.until(null);
    expect(blakeStream.state.text).toContain('event: session.ended');
    await new Promise((r) => setTimeout(r, 200));
    expect(averyStream.state.done).toBe(false);
    await averyStream.close();
    await t.close();
  });

  it('a show-once secret is not written to the stream of a session that ended (held instead, then expires)', async () => {
    // Default poll (10 s): the stream is still attached when the secret arrives.
    const t = await setup();
    const { avery, runId, address } = await parkedRun(t);
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    const stream = await openStream(address, avery.headers.cookie, runId);
    await stream.until('"status":"awaiting_approval"');
    await t.sessions.delete(avery.record.idHash);

    expect((await blake.post(`/api/runs/${runId}/approvals/ok`, { decision: 'approve' })).statusCode).toBe(
      200,
    );
    await t.drain();
    await stream.until('event: end');
    expect(stream.state.text).not.toContain(TAP);
    expect(stream.state.text).not.toContain('"type":"secret"');
    expect(t.audit.rows.filter((r) => r.action === 'run.secret.revealed')).toEqual([]);
    expect(t.runs.secrets.heldCount).toBe(1);
    await t.close();
  });

  it('a live session still gets the secret on its stream', async () => {
    const t = await setup();
    const { avery, runId, address } = await parkedRun(t);
    const blake = await t.login(BLAKE, APPROVER, { armed: true });
    const stream = await openStream(address, avery.headers.cookie, runId);
    await stream.until('"status":"awaiting_approval"');
    await blake.post(`/api/runs/${runId}/approvals/ok`, { decision: 'approve' });
    await t.drain();
    await stream.until('event: end');
    expect(stream.state.text).toContain(TAP);
    expect(t.runs.secrets.heldCount).toBe(0);
    await t.close();
  });
});
