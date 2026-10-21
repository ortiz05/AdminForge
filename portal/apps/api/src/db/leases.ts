import type BetterSqlite3 from 'better-sqlite3';

/**
 * Named leases in the `leases` table (ADR-016; replace Postgres advisory locks). A lease belongs to its holder until
 * it expires; the holder renews it while it needs it. A process that dies simply stops renewing, and the lease is free
 * again after its TTL — the equivalent of Postgres releasing a dead session's advisory lock.
 *
 * Holders are unique per acquisition (process id + random), so a second acquisition in the same process fails like it
 * would from another process.
 */
export class Leases {
  constructor(
    private readonly sqlite: BetterSqlite3.Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes the lease when it is free or expired (or already ours: then it is renewed). */
  tryAcquire(name: string, holder: string, ttlMs: number): boolean {
    const t = this.now();
    const row = this.sqlite
      .prepare(
        `insert into leases (name, holder, expires_at) values (?, ?, ?)
         on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
           where leases.expires_at <= ? or leases.holder = excluded.holder
         returning holder`,
      )
      .get(name, holder, t + ttlMs, t) as { holder: string } | undefined;
    return row?.holder === holder;
  }

  /** Extends a lease we hold; false when it expired and someone else took it (or it was released). */
  renew(name: string, holder: string, ttlMs: number): boolean {
    const t = this.now();
    return (
      this.sqlite
        .prepare('update leases set expires_at = ? where name = ? and holder = ? and expires_at > ?')
        .run(t + ttlMs, name, holder, t).changes === 1
    );
  }

  release(name: string, holder: string): void {
    this.sqlite.prepare('delete from leases where name = ? and holder = ?').run(name, holder);
  }

  /** Who holds a lease now (null when free or expired). */
  holder(name: string): string | null {
    const row = this.sqlite
      .prepare('select holder from leases where name = ? and expires_at > ?')
      .get(name, this.now()) as { holder: string } | undefined;
    return row?.holder ?? null;
  }

  /** Removes expired leases (housekeeping; correctness never depends on it). */
  purgeExpired(): number {
    return this.sqlite.prepare('delete from leases where expires_at <= ?').run(this.now()).changes;
  }
}
