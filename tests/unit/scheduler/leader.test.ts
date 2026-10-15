import { LeaderElector, type LeaderLock } from '@adminforge/api/src/schedules/leader';
import { FakeClock } from './helpers';

/** One shared advisory lock (what Postgres does), with a per-holder "connection" that can drop. */
class FakeLockServer {
  holder: string | null = null;
  readonly alive = new Set<string>();
  lock(name: string): LeaderLock {
    return {
      tryAcquire: async () => {
        this.alive.add(name);
        if (this.holder && this.holder !== name && this.alive.has(this.holder)) return false;
        this.holder = name;
        return true;
      },
      check: async () => this.holder === name && this.alive.has(name),
      release: async () => {
        if (this.holder === name) this.holder = null;
      },
    };
  }
  /** The holder's database connection drops: Postgres releases its session lock. */
  drop(name: string) {
    this.alive.delete(name);
    if (this.holder === name) this.holder = null;
  }
}

function node(server: FakeLockServer, clock: FakeClock, name: string, events: string[]) {
  return new LeaderElector(server.lock(name), {
    intervalMs: 5_000,
    timers: clock,
    onElected: () => {
      events.push(`${name}:elected`);
    },
    onDemoted: (reason) => {
      events.push(`${name}:demoted:${reason.split(' ')[0]}`);
    },
  });
}

describe('leader election (advisory lock)', () => {
  it('elects exactly one scheduler; the standby takes over when the leader stops', async () => {
    const clock = new FakeClock();
    const server = new FakeLockServer();
    const events: string[] = [];
    const a = node(server, clock, 'a', events);
    const b = node(server, clock, 'b', events);
    await a.start();
    await b.start();
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    await clock.advance(30_000);
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);

    await a.stop();
    expect(a.isLeader).toBe(false);
    await clock.advance(5_000);
    expect(b.isLeader).toBe(true);
    expect(events).toEqual(['a:elected', 'a:demoted:shutting', 'b:elected']);
    await b.stop();
  });

  it('demotes a leader whose connection dropped and lets the standby in on its next attempt', async () => {
    const clock = new FakeClock();
    const server = new FakeLockServer();
    const events: string[] = [];
    const a = node(server, clock, 'a', events);
    const b = node(server, clock, 'b', events);
    await a.start();
    await b.start();
    server.drop('a');
    await clock.advance(5_000);
    expect(a.isLeader).toBe(false);
    expect(b.isLeader).toBe(true);
    // a reconnects but cannot take the lock back while b holds it.
    await clock.advance(20_000);
    expect([a.isLeader, b.isLeader]).toEqual([false, true]);
    expect(events).toEqual(['a:elected', 'a:demoted:lost', 'b:elected']);
    await a.stop();
    await b.stop();
  });

  it('keeps campaigning through lock errors', async () => {
    const clock = new FakeClock();
    let fail = true;
    const warnings: string[] = [];
    const e = new LeaderElector(
      {
        tryAcquire: async () => (fail ? Promise.reject(new Error('connection refused')) : true),
        check: async () => true,
        release: async () => undefined,
      },
      { intervalMs: 1_000, timers: clock, log: { warn: (_o, m) => warnings.push(m) } },
    );
    await e.start();
    expect(e.isLeader).toBe(false);
    fail = false;
    await clock.advance(1_000);
    expect(e.isLeader).toBe(true);
    expect(warnings).toEqual(['scheduler: leader election attempt failed']);
    await e.stop();
    expect(clock.timers).toBe(0);
  });
});
