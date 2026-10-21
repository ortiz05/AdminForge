import { MAX_RUN_STREAMS_PER_SESSION } from '@adminforge/api/src/routes/runs';
import { mockConfig } from './helpers';
import { AVERY, BLAKE, runsApp } from './runs-helpers';
import { capDefinitions, OPERATOR } from './runs-per-user-cap-cases';

// D-24: like GET /api/events, one session holds at most MAX_RUN_STREAMS_PER_SESSION open run streams
// (GET /api/runs/:id/events — one per open run page); a further one is refused with a friendly 429 until one closes.
// Another session, and the session's own /api/events streams, are unaffected. The run page polls meanwhile.
describe('run streams per session (D-24)', () => {
  it('refuses the stream over the limit, and frees a slot when one closes', async () => {
    const t = await runsApp({
      config: mockConfig(),
      definitions: capDefinitions(),
      runs: { inProcessWorker: false }, // the runs stay queued, so their streams stay open
    });
    // The streams' timers are real: follow real time so the sessions don't look idle.
    t.clock.t = Date.now();
    const avery = await t.login(AVERY, OPERATOR);
    const blake = await t.login(BLAKE, OPERATOR);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const start = async (who: typeof avery) =>
      (await who.post('/api/runs', { playbook: 'test.cap', inputs: {}, dryRun: true })).json()
        .runId as string;
    const open = async (url: string, cookie = avery.headers.cookie) => {
      const ac = new AbortController();
      const res = await fetch(`${address}${url}`, { headers: { cookie }, signal: ac.signal });
      return {
        res,
        close: async () => {
          ac.abort();
          await res.body?.cancel().catch(() => undefined);
        },
      };
    };
    try {
      const runs = [await start(avery), await start(avery)];
      const streams = [];
      for (let i = 0; i < MAX_RUN_STREAMS_PER_SESSION; i++) {
        const s = await open(`/api/runs/${runs[i % 2]}/events`);
        expect(s.res.status).toBe(200);
        streams.push(s);
      }
      const refused = await open(`/api/runs/${runs[0]}/events`);
      expect(refused.res.status).toBe(429);
      const error = (await refused.res.json()).error;
      expect(error).toMatchObject({
        code: 'too_many_streams',
        message: 'Live updates of runs are already open in too many tabs or windows.',
      });
      expect(error.hint).toMatch(/Close the run pages you don’t need/);

      // An unknown run is still a 404, not a 429.
      expect((await open('/api/runs/00000000-0000-4000-8000-000000000000/events')).res.status).toBe(404);
      // The session's /api/events stream has its own allowance, and so does another session.
      const events = await open('/api/events');
      expect(events.res.status).toBe(200);
      await events.close();
      const other = await open(`/api/runs/${await start(blake)}/events`, blake.headers.cookie);
      expect(other.res.status).toBe(200);
      await other.close();

      await streams.shift()!.close();
      // The server notices the closed connection asynchronously.
      let again = await open(`/api/runs/${runs[1]}/events`);
      for (let i = 0; i < 50 && again.res.status !== 200; i++) {
        await again.close();
        await new Promise((r) => setTimeout(r, 20));
        again = await open(`/api/runs/${runs[1]}/events`);
      }
      expect(again.res.status).toBe(200);
      streams.push(again);
      for (const s of streams) await s.close();
    } finally {
      await t.close();
    }
  });

  it('a stream that ends by itself (a finished run) gives its slot back', async () => {
    const t = await runsApp({ config: mockConfig(), definitions: capDefinitions() });
    t.clock.t = Date.now();
    const avery = await t.login(AVERY, OPERATOR);
    try {
      const { runId } = (
        await avery.post('/api/runs', { playbook: 'test.cap', inputs: {}, dryRun: true })
      ).json();
      await t.drain();
      // A finished run's stream replays and ends at once; ten in a row never hit the limit.
      for (let i = 0; i < 2 * MAX_RUN_STREAMS_PER_SESSION; i++) {
        const res = await avery.get(`/api/runs/${runId}/events`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('event: end');
      }
    } finally {
      await t.close();
    }
  });
});
