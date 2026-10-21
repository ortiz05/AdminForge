import { randomUUID } from 'node:crypto';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { pruneBudget } from '@adminforge/api/src/housekeeping/budget';
import { applyRetention } from '@adminforge/api/src/housekeeping/retention';
import { SqliteNewsStore } from '@adminforge/api/src/news/sqlite-store';
import { testDatabasePath } from './db';

// D-02 follow-up: retention deleted its tables in batches with the event loop let in and stopped at a time budget, but
// News and changes items went in one statement per feed, however many there were. They go in batches of 2,000 too,
// within the same pass budget: a pass that runs out of time says `pending` and the next one finishes.
const file = await testDatabasePath();
const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const POLICY = { runDays: 180, scheduleRunDays: 180, probeDays: 35, artifactDays: 90 };

describe('News and changes retention in batches (SQLite)', () => {
  let database: Database;
  let store: SqliteNewsStore;
  beforeAll(() => {
    database = createDatabase(file);
    store = new SqliteNewsStore(database);
  });
  beforeEach(() => {
    database.sqlite.exec('delete from news_items; delete from news_feed_state;');
  });
  afterAll(async () => {
    await database?.close();
  });

  const count = () =>
    (database.sqlite.prepare('select count(*) as n from news_items').get() as { n: number }).n;

  function items(feedKey: string, n: number, daysAgo: number) {
    const insert = database.sqlite.prepare(
      `insert into news_items (id, feed_key, external_id, title, summary, url, kind, severity, areas, tags, status,
         audience, published_at, activity_at, first_seen_at, last_seen_at, changed_at, content_hash, facts)
       values (?, ?, ?, 'Item', '', 'https://example.com/news', 'change', 'normal', '[]', '[]', null, '[]', ?, ?, ?, ?, ?,
         'h', '[]')`,
    );
    const at = NOW.getTime() - daysAgo * DAY;
    database.sqlite.transaction(() => {
      for (let i = 0; i < n; i++)
        insert.run(randomUUID(), feedKey, `${feedKey}-${daysAgo}-${i}`, at, at, at, at, at);
    })();
  }

  const policy = { now: NOW, feeds: new Map([['feeds.a', 30]]), orphanDays: 30 };

  it('deletes 5,000 old items of a feed in batches and lets the event loop run between them', async () => {
    items('feeds.a', 5_000, 40);
    items('feeds.a', 10, 1);
    const seen: number[] = [];
    setImmediate(() => seen.push(count()));
    expect(await store.prune(policy, pruneBudget())).toBe(5_000);
    expect(seen).toEqual([3_010]);
    expect(count()).toBe(10);
  });

  it("batches a removed feed's items the same way", async () => {
    items('feeds.gone', 4_500, 40);
    const seen: number[] = [];
    setImmediate(() => seen.push(count()));
    expect(await store.prune(policy, pruneBudget())).toBe(4_500);
    expect(seen).toEqual([2_500]);
    expect(count()).toBe(0);
  });

  it('stops at the time budget (pending) and finishes on the next pass', async () => {
    items('feeds.a', 5_000, 40);
    // Reads 0 at the start and 10 s ever after: the 2 s budget is spent after the first batch.
    let reads = 0;
    const budget = pruneBudget({ clock: () => (reads++ === 0 ? 0 : 10_000) });
    expect(await store.prune(policy, budget)).toBe(2_000);
    expect(budget.pending).toBe(true);
    expect(count()).toBe(3_000);
    expect(await store.prune(policy)).toBe(3_000);
    expect(count()).toBe(0);
  });

  it("retention gives News and changes the pass's remaining budget and says pending when it ran out", async () => {
    items('feeds.a', 5_000, 40);
    const news = {
      prune: (now: Date, budget?: Parameters<SqliteNewsStore['prune']>[1]) =>
        store.prune({ ...policy, now }, budget),
    };
    let reads = 0;
    const clock = () => (reads++ === 0 ? 0 : 10_000);
    const audit = new MemoryAuditWriter(() => NOW);
    const first = await applyRetention(database.db, { artifacts: null, audit, now: NOW, news }, POLICY, {
      budgetMs: 2_000,
      clock,
    });
    expect(first).toMatchObject({ news: 2_000, pending: true });
    const second = await applyRetention(database.db, { artifacts: null, audit, now: NOW, news }, POLICY);
    expect(second).toMatchObject({ news: 3_000, pending: false });
    expect(count()).toBe(0);
  });
});
