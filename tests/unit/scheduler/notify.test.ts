import { AppError } from '@adminforge/api/src/errors';
import { FakeJobs, harness, schedule } from './helpers';

// notify.onFailure: people hear about a schedule only when it has really failed (no retry left), through the
// configured Teams webhook / email; the outcome is audited.
const HOOK = 'https://example.webhook.office.com/webhookb2/alerts';

function setup(retry?: { max: number }) {
  const posts: Array<{ url: string; body: string }> = [];
  const jobs = new FakeJobs(() => {
    throw new AppError(502, 'upstream_error', 'Microsoft Graph answered 502.');
  });
  const h = harness({
    jobs,
    delivery: {
      outbound: {} as never,
      fetch: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: String(init.body) });
        return new Response('', { status: 202 });
      }) as never,
      env: { AF_TEAMS_ALERTS_WEBHOOK: HOOK },
      publicBaseUrl: 'https://portal.example.com',
    },
  });
  h.defs.set(
    schedule('sweep.a', {
      enabled: false,
      ...(retry ? { retry: { ...retry, backoff: 'fixed', delay: '1m' } } : {}),
      notify: { onFailure: [{ type: 'teams', webhook: '${ env.AF_TEAMS_ALERTS_WEBHOOK }' }] },
    }),
  );
  return { h, posts };
}

describe('schedule failure notifications', () => {
  it('posts to Teams with the error and a link when the run fails for good, and audits it', async () => {
    const { h, posts } = setup();
    await h.scheduler.runOnce('sweep.a', 'cli:operator').catch(() => undefined);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(HOOK);
    expect(posts[0]!.body).toMatch(/failed: Microsoft Graph answered 502/);
    expect(posts[0]!.body).toContain('https://portal.example.com/schedules/sweep.a');
    expect(h.audit.rows.find((r) => r.action === 'schedule.notified')).toMatchObject({ result: 'success' });
  });

  it('stays quiet while a retry is still coming', async () => {
    const { h, posts } = setup({ max: 2 });
    await h.scheduler.runOnce('sweep.a', 'cli:operator').catch(() => undefined);
    expect(posts).toHaveLength(0);
  });
});
