import { createJobRunner, type JobContext, type JobDeps } from '@adminforge/api/src/schedules/jobs';
import type { NewsService, RefreshResult } from '@adminforge/api/src/news/service';
import { Schedule } from '@adminforge/schemas';

// `job: news`: hands over to the news service; the run result carries counts only; failed only when every feed that
// was due failed (or there is nothing to collect); news.updated goes out when something changed.
const schedule = (job: Record<string, unknown>) =>
  Schedule.parse({
    kind: 'schedule',
    id: 'maintenance.news',
    version: '1.0.0',
    title: 'News',
    owner: 't',
    cron: '5 * * * *',
    job,
  });

function runner(result: RefreshResult | Error) {
  const calls: unknown[] = [];
  const events: unknown[] = [];
  const news = {
    refresh: async (opts: unknown) => {
      calls.push(opts);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as NewsService;
  const jobs = createJobRunner({
    news,
    onNews: (c: { new: number; updated: number }) => events.push(c),
  } as unknown as JobDeps);
  const run = (job: Record<string, unknown>) =>
    jobs.run({
      def: schedule(job),
      signal: new AbortController().signal,
      correlationId: 'c-1',
    } as unknown as JobContext);
  return { run, calls, events };
}

const res = (over: Partial<RefreshResult>): RefreshResult => ({
  feeds: 3,
  ok: 3,
  failed: 0,
  skipped: 0,
  new: 0,
  updated: 0,
  results: [],
  ...over,
});

describe('news job', () => {
  it('passes refs and concurrency, returns counts and publishes news.updated when something changed', async () => {
    const t = runner(res({ new: 4, updated: 1 }));
    const out = await t.run({ kind: 'news', refs: ['feeds.a'], concurrency: 2 });
    expect(t.calls[0]).toMatchObject({ refs: ['feeds.a'], concurrency: 2, correlationId: 'c-1' });
    expect(out).toEqual({ result: res({ new: 4, updated: 1 }) });
    expect(t.events).toEqual([{ new: 4, updated: 1 }]);
  });

  it('stays quiet when nothing changed, and succeeds when only some feeds failed or were skipped', async () => {
    const quiet = runner(res({ ok: 1, failed: 1, skipped: 1 }));
    expect((await quiet.run({ kind: 'news' })).status).toBeUndefined();
    expect(quiet.events).toEqual([]);
  });

  it('fails when every due feed failed, or there is no feed at all', async () => {
    const allFailed = await runner(res({ ok: 0, failed: 2, skipped: 1 })).run({ kind: 'news' });
    expect(allFailed).toMatchObject({ status: 'failed', error: { code: 'feeds_failed' } });
    const none = await runner(res({ feeds: 0, ok: 0 })).run({ kind: 'news' });
    expect(none).toMatchObject({
      status: 'failed',
      error: { code: 'no_feeds', hint: expect.stringMatching(/publish/) },
    });
    const allSkipped = await runner(res({ ok: 0, skipped: 3 })).run({ kind: 'news' });
    expect(allSkipped.status).toBeUndefined();
  });

  it('explains when news collection is not available in this process', async () => {
    const jobs = createJobRunner({} as unknown as JobDeps);
    await expect(
      jobs.run({
        def: schedule({ kind: 'news' }),
        signal: new AbortController().signal,
      } as unknown as JobContext),
    ).rejects.toMatchObject({ code: 'news_not_available' });
  });
});
