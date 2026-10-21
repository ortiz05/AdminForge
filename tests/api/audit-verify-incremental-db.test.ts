import { SqliteAuditWriter, type CheckpointSink } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { triggerStatement } from '@adminforge/api/src/db/migrate';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { Probe } from '@adminforge/schemas';
import { testDatabasePath } from './db';

// D-05 (decision: hourly incremental check plus a daily full walk). probes.audit-chain re-walked the whole chain every
// hour; it now verifies only the events after the last verified checkpoint (seq + hash, held in memory) — after
// confirming the checkpoint event itself is still there, unchanged — and walks the whole chain at start and once a
// day. The shipped checkpoints stay the external anchor; every check logs one.
const HOUR = 3_600_000;
const START = new Date('2026-10-15T12:00:00Z').getTime();

describe('incremental audit-chain verification (SQLite)', () => {
  let database: Database;
  let writer: SqliteAuditWriter;
  let now: number;
  let shipped: Array<Parameters<CheckpointSink>[0]>;

  beforeEach(async () => {
    database = createDatabase(await testDatabasePath());
    now = START;
    shipped = [];
    writer = new SqliteAuditWriter(
      database.db,
      () => new Date(now),
      (cp) => shipped.push(cp),
      4,
    );
  });
  afterEach(async () => {
    await database.close();
  });

  const append = async (n: number) => {
    for (let i = 0; i < n; i++)
      await writer.append({
        actorOid: 'u1',
        actorUpn: 'avery@example.com',
        mode: 'read',
        action: 'test.event',
        correlationId: `c-${now}-${i}`,
        result: 'success',
        details: { i },
      });
  };
  /** Rewrites one event the way someone with write access to the volume could (the triggers stop the application). */
  const tamper = (sql: string, ...args: unknown[]) => {
    database.sqlite.exec('drop trigger audit_events_no_update; drop trigger audit_events_no_delete;');
    database.sqlite.prepare(sql).run(...args);
    database.sqlite.exec(triggerStatement('audit_events_no_update'));
    database.sqlite.exec(triggerStatement('audit_events_no_delete'));
  };
  const seqs = () =>
    (
      database.sqlite.prepare('select seq from audit_events order by seq').all() as Array<{ seq: number }>
    ).map((r) => r.seq);

  it('walks the whole chain first, then only what was appended after the last checkpoint', async () => {
    await append(5);
    expect(await writer.verifyIncremental()).toMatchObject({ ok: true, scope: 'full', count: 5, checked: 5 });
    await append(3);
    now += HOUR;
    const r = await writer.verifyIncremental();
    expect(r).toMatchObject({ ok: true, scope: 'incremental', count: 8, checked: 3 });
    expect(r.ok && r.tail).toEqual({ seq: seqs().at(-1), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Every check ships its checkpoint (the external anchor), with the chain's length.
    expect(shipped.map((c) => [c.seq, c.count])).toEqual([
      [seqs()[4], 5],
      [seqs()[7], 8],
    ]);
  });

  it('nothing new: checks the checkpoint event and reads nothing else', async () => {
    await append(3);
    await writer.verifyIncremental();
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({
      ok: true,
      scope: 'incremental',
      count: 3,
      checked: 0,
    });
  });

  it('walks the whole chain again once the last full walk is a day old', async () => {
    await append(6);
    await writer.verifyIncremental();
    now += 23 * HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({ scope: 'incremental' });
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({ ok: true, scope: 'full', count: 6, checked: 6 });
  });

  it('a full verification from anywhere in the process (the Audit page) counts as the daily walk', async () => {
    await append(2);
    expect(await writer.verify()).toMatchObject({ ok: true, count: 2 });
    await append(1);
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({
      ok: true,
      scope: 'incremental',
      count: 3,
      checked: 1,
    });
  });

  it('finds an event changed after the checkpoint', async () => {
    await append(4);
    await writer.verifyIncremental();
    await append(4);
    const changed = seqs()[6]!;
    tamper(`update audit_events set details = '{"i":99}' where seq = ?`, changed);
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({
      ok: false,
      scope: 'incremental',
      seq: changed,
      brokenAt: 6,
    });
  });

  it('finds the checkpoint event itself changed or removed', async () => {
    await append(3);
    await writer.verifyIncremental();
    const checkpoint = seqs().at(-1)!;
    tamper(`update audit_events set actor_upn = 'someone@example.com' where seq = ?`, checkpoint);
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({ ok: false, seq: checkpoint, brokenAt: 2 });

    // A broken result trusts no checkpoint: the next check walks the whole chain.
    expect(await writer.verifyIncremental()).toMatchObject({ ok: false, scope: 'full', seq: checkpoint });
  });

  it('a removed checkpoint event is noticed even when new events follow it', async () => {
    await append(3);
    await writer.verifyIncremental();
    const checkpoint = seqs().at(-1)!;
    tamper('delete from audit_events where seq = ?', checkpoint);
    await append(2);
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({
      ok: false,
      scope: 'incremental',
      seq: checkpoint,
    });
  });

  it('leaves events before the checkpoint to the daily full walk', async () => {
    await append(5);
    await writer.verifyIncremental();
    const first = seqs()[0]!;
    tamper(`update audit_events set result = 'failure' where seq = ?`, first);
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({ ok: true, scope: 'incremental' });
    now += 24 * HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({
      ok: false,
      scope: 'full',
      seq: first,
      brokenAt: 0,
    });
  });

  it('a chain rewritten from the start re-hashes cleanly, but not onto the checkpoint already verified', async () => {
    await append(3);
    await writer.verifyIncremental();
    const checkpoint = seqs().at(-1)!;
    // Everything removed and new events written: a consistent chain of its own, from the genesis hash.
    tamper('delete from audit_events');
    await append(2);
    expect(await writer.verify()).toMatchObject({ ok: false, seq: checkpoint, brokenAt: 2 });
    // Another process (no checkpoint of its own) sees a chain that verifies: the shipped checkpoints are the anchor.
    expect(await new SqliteAuditWriter(database.db, () => new Date(now), null).verify()).toMatchObject({
      ok: true,
      count: 2,
    });
  });

  it('a break another walk found meanwhile is not papered over by a walk that started before it', async () => {
    await append(3);
    await writer.verifyIncremental();
    await append(10);
    tamper(`update audit_events set result = 'failure' where seq = ?`, seqs()[0]);
    now += HOUR;
    // The hourly check walks the new events in batches (yielding between them); the Audit page's full walk finds the
    // change before it while it is under way.
    const hourly = writer.verifyIncremental();
    const page = writer.verify();
    expect(await page).toMatchObject({ ok: false, seq: seqs()[0] });
    expect(await hourly).toMatchObject({ ok: true, scope: 'incremental' });
    now += HOUR;
    expect(await writer.verifyIncremental()).toMatchObject({ ok: false, scope: 'full', seq: seqs()[0] });
  });

  describe('probes.audit-chain', () => {
    const chainProbe = Probe.parse({
      kind: 'probe',
      id: 'probes.audit-chain',
      version: '1.1.0',
      title: 'Audit log integrity',
      owner: 'portal-admins',
      check: { kind: 'auditChain' },
    });
    const deps = () =>
      ({
        outbound: {} as ProbeDeps['outbound'],
        automation: null,
        connection: async () => Promise.reject(new Error('unused')),
        env: () => ({}),
        now: () => new Date(now),
        fetch: async () => new Response(''),
        audit: writer,
      }) as ProbeDeps;

    it('says whether it walked the whole chain or what was added since the last check', async () => {
      await append(4);
      const full = await runProbe('probes.audit-chain', chainProbe, deps());
      expect(full).toMatchObject({ status: 'ok', metric: 4 });
      expect(full.message).toBe(
        '4 audit events verified (the whole chain); every hash links to the one before it.',
      );
      await append(2);
      now += HOUR;
      const recent = await runProbe('probes.audit-chain', chainProbe, deps());
      expect(recent).toMatchObject({ status: 'ok', metric: 6 });
      expect(recent.message).toBe(
        '2 new audit events verified since the last check (6 in all); the whole chain is re-walked daily.',
      );
    });

    it('is critical when the incremental check finds a changed event', async () => {
      await append(2);
      await runProbe('probes.audit-chain', chainProbe, deps());
      await append(2);
      tamper(`update audit_events set details = '{"i":7}' where seq = ?`, seqs()[3]);
      now += HOUR;
      expect(await runProbe('probes.audit-chain', chainProbe, deps())).toMatchObject({
        status: 'crit',
        code: 'audit_chain_broken',
        metric: 3,
      });
    });
  });
});
