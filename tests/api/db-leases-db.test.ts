import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { Leases } from '@adminforge/api/src/db/leases';
import { LeaderElector, leaseLock, SCHEDULER_LEASE_MS } from '@adminforge/api/src/schedules/leader';
import { SqliteRunRepository } from '@adminforge/api/src/runs/sqlite-repository';
import { testDatabasePath } from './db';

// Leases replace Postgres advisory locks (ADR-016): the scheduler's leadership and per-run locks. A holder keeps a
// lease by renewing it; a process that dies stops renewing and the lease is free after its TTL.
describe('leases (SQLite)', () => {
  let file: string;
  let a: Database;
  let b: Database;
  let t: number;
  const now = () => t;

  beforeEach(async () => {
    file = await testDatabasePath();
    a = createDatabase(file, { name: 'api' });
    b = createDatabase(file, { name: 'second' });
    t = 1_000_000;
  });
  afterEach(async () => {
    await a.close();
    await b.close();
  });

  it('one holder at a time; renewals keep it; it is free once released or expired', () => {
    const la = new Leases(a.sqlite, now);
    const lb = new Leases(b.sqlite, now);
    expect(la.tryAcquire('x', 'holder-a', 10_000)).toBe(true);
    expect(lb.tryAcquire('x', 'holder-b', 10_000)).toBe(false);
    expect(la.tryAcquire('x', 'holder-a', 10_000)).toBe(true); // the holder itself: renewed
    t += 9_000;
    expect(la.renew('x', 'holder-a', 10_000)).toBe(true);
    t += 9_000;
    expect(lb.tryAcquire('x', 'holder-b', 10_000)).toBe(false); // renewed: still held
    t += 2_000;
    expect(lb.holder('x')).toBeNull(); // expired
    expect(lb.tryAcquire('x', 'holder-b', 10_000)).toBe(true);
    expect(la.renew('x', 'holder-a', 10_000)).toBe(false); // lost it
    lb.release('x', 'holder-b');
    expect(la.tryAcquire('x', 'holder-a', 10_000)).toBe(true);
    la.release('x', 'someone-else'); // only the holder releases
    expect(la.holder('x')).toBe('holder-a');
    t += 20_000;
    expect(la.purgeExpired()).toBe(1);
  });

  it('the scheduler: one leader across processes; a standby takes over when the leader stops renewing', async () => {
    const timers = { setTimeout: () => 0, clearTimeout: () => undefined };
    const events: string[] = [];
    const leader = new LeaderElector(leaseLock(a, { now }), {
      timers,
      onElected: () => void events.push('a elected'),
      onDemoted: (r) => void events.push(`a demoted: ${r}`),
    });
    const standby = new LeaderElector(leaseLock(b, { now }), {
      timers,
      onElected: () => void events.push('b elected'),
    });
    await leader.start();
    await standby.start();
    expect([leader.isLeader, standby.isLeader]).toEqual([true, false]);
    // The leader hangs (no renewals) past the lease: the standby is elected; the old leader notices and steps down.
    t += SCHEDULER_LEASE_MS + 1;
    await standby.step();
    expect(standby.isLeader).toBe(true);
    await leader.step();
    expect(leader.isLeader).toBe(false);
    expect(events).toEqual([
      'a elected',
      'b elected',
      'a demoted: lost the scheduler lease (it expired, or another process took it)',
    ]);
    await standby.stop();
    await leader.stop();
  });

  it("a run's lock: a second driver (this process or another) gets nothing until it is released", async () => {
    const ra = new SqliteRunRepository(a);
    const rb = new SqliteRunRepository(b);
    const lock = await ra.tryLock('run-1');
    expect(lock).not.toBeNull();
    expect(await ra.tryLock('run-1')).toBeNull();
    expect(await rb.tryLock('run-1')).toBeNull();
    expect(await rb.tryLock('run-2')).not.toBeNull();
    await lock!.release();
    await lock!.release(); // idempotent
    expect(await rb.tryLock('run-1')).not.toBeNull();
  });

  it('a lapsed run lock tells its holder, which then stops at the next checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const ra = new SqliteRunRepository(a, () => new Date(t));
      const rb = new SqliteRunRepository(b, () => new Date(t));
      const lock = (await ra.tryLock('run-9'))!;
      vi.advanceTimersByTime(30_000); // renewed while it is alive
      expect(lock.lost?.aborted).toBe(false);
      t += 121_000; // then this process stalls past the lease…
      expect(await rb.tryLock('run-9')).not.toBeNull(); // …and another worker takes the run over
      vi.advanceTimersByTime(30_000);
      expect(lock.lost?.aborted).toBe(true);
      await lock.release(); // releasing a lapsed lock does not free the new holder's
      expect(await ra.tryLock('run-9')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
