import { MAX_STREAMS_PER_SESSION } from '@adminforge/api/src/routes/events';
import { makeApp, mockConfig, mockLogin } from './helpers';

// APP-06: one session can hold at most MAX_STREAMS_PER_SESSION open /api/events streams (tabs and windows); a further
// one is refused with a friendly 429 until one closes. Another session is unaffected.
describe('event streams per session (APP-06)', () => {
  it('refuses the stream over the limit, and frees a slot when one closes', async () => {
    const t = await makeApp(mockConfig());
    // The streams' timers are real: follow real time so the session doesn't look idle.
    t.clock.t = Date.now();
    const { cookie } = await mockLogin(t.app);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const open = async (c = cookie) => {
      const ac = new AbortController();
      const res = await fetch(`${address}/api/events`, { headers: { cookie: c }, signal: ac.signal });
      return {
        res,
        close: async () => {
          ac.abort();
          await res.body?.cancel().catch(() => undefined);
        },
      };
    };
    const streams = [];
    for (let i = 0; i < MAX_STREAMS_PER_SESSION; i++) {
      const s = await open();
      expect(s.res.status).toBe(200);
      streams.push(s);
    }
    const refused = await open();
    expect(refused.res.status).toBe(429);
    const error = (await refused.res.json()).error;
    expect(error).toMatchObject({
      code: 'too_many_streams',
      message: 'Live updates are already open in too many tabs or windows.',
    });
    expect(error.hint).toMatch(/Close the AdminForge tabs or windows you don’t need/);

    // Another session has its own allowance.
    const other = await open((await mockLogin(t.app)).cookie);
    expect(other.res.status).toBe(200);
    await other.close();

    await streams.shift()!.close();
    // The server notices the closed connection asynchronously.
    let again = await open();
    for (let i = 0; again.res.status !== 200 && i < 50; i++) {
      await again.close();
      await new Promise((r) => setTimeout(r, 20));
      again = await open();
    }
    expect(again.res.status).toBe(200);
    streams.push(again);
    for (const s of streams) await s.close();
    await t.app.close();
  });
});
