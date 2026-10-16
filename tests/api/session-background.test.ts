import { BACKGROUND_HEADER } from '@adminforge/api/src/auth/session-plugin';
import { makeApp, MINUTE, mockConfig, mockLogin } from './helpers';

// IAM-05: polling and auto-refresh (X-AdminForge-Background: 1) authenticate as usual but don't count as activity, so
// a tab left open still reaches the idle timeout.
describe('background requests and the idle timeout (IAM-05)', () => {
  it('a background request authenticates but does not move lastSeenAt; a foreground one does', async () => {
    const t = await makeApp(mockConfig());
    const { cookie } = await mockLogin(t.app);
    const [session] = [...t.sessions.rows.values()];
    const signedInAt = session!.lastSeenAt.getTime();

    t.clock.advance(5 * MINUTE);
    const bg = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie, [BACKGROUND_HEADER]: '1' },
    });
    expect(bg.statusCode).toBe(200);
    expect([...t.sessions.rows.values()][0]!.lastSeenAt.getTime()).toBe(signedInAt);

    const fg = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie } });
    expect(fg.statusCode).toBe(200);
    expect([...t.sessions.rows.values()][0]!.lastSeenAt.getTime()).toBe(t.clock.t);
    await t.app.close();
  });

  it('only the value 1 marks a request as background', async () => {
    const t = await makeApp(mockConfig());
    const { cookie } = await mockLogin(t.app);
    t.clock.advance(5 * MINUTE);
    await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie, [BACKGROUND_HEADER]: 'true' } });
    expect([...t.sessions.rows.values()][0]!.lastSeenAt.getTime()).toBe(t.clock.t);
    await t.app.close();
  });

  it('a tab that only polls is signed out at the idle timeout', async () => {
    const config = mockConfig();
    const t = await makeApp(config);
    const { cookie } = await mockLogin(t.app);
    const poll = () =>
      t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie, [BACKGROUND_HEADER]: '1' } });
    // Poll every 30 s for the whole idle window.
    for (let elapsed = 0; elapsed < config.SESSION_IDLE_MINUTES * MINUTE; elapsed += 30_000) {
      t.clock.advance(30_000);
      expect((await poll()).statusCode).toBe(200);
    }
    t.clock.advance(30_000);
    const res = await poll();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
    expect(t.sessions.rows.size).toBe(0);
    await t.app.close();
  });
});
