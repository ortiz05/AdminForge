import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '@adminforge/api/src/app';
import { CHAIN_KEYED_ACTION, chainHash, GENESIS } from '@adminforge/api/src/audit/chain';
import { chainKeysFrom, type ChainKeyring } from '@adminforge/api/src/audit/keys';
import { AuditChainKeyError, AuditChainPinError, SqliteAuditWriter } from '@adminforge/api/src/audit/writer';
import { createContext } from '@adminforge/api/src/context';
import { backupDatabase } from '@adminforge/api/src/db/backup';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { triggerStatement } from '@adminforge/api/src/db/migrate';
import { auditVerify } from '@adminforge/cli/src/commands/audit';
import { dbBackup, dbSignOutEveryone } from '@adminforge/cli/src/commands/db';
import { testDatabasePath } from './db';
import { cookieFrom, getMe, mockConfig } from './helpers';

// S-10 on the database file: with AUDIT_CHAIN_KEY the API appends a cut-over event at start (once per key), and from it
// on every event — the API's and the CLI's — is HMAC-SHA256 with that key. Without the key, a keyed chain is refused:
// the API doesn't start, the CLI's writing commands change nothing. Verification (full, incremental, backups,
// `adminforge audit verify [--checkpoint]`) handles both parts. The key never reaches the file, a backup, a log line or
// a response.
const newKey = () => randomBytes(32).toString('base64');

interface Row {
  seq: number;
  ts: number;
  actor_oid: string | null;
  actor_upn: string | null;
  session_hash: string | null;
  mode: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  result: string;
  correlation_id: string;
  ip: string | null;
  prev_hash: string;
  hash: string;
}

/** The hashed event of a stored row (as the audit writer hashes it). */
const eventOf = (r: Row) => ({
  ts: new Date(r.ts).toISOString(),
  actorOid: r.actor_oid,
  actorUpn: r.actor_upn,
  sessionHash: r.session_hash,
  mode: r.mode,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
  result: r.result,
  correlationId: r.correlation_id,
  ip: r.ip,
});

describe('keyed audit chain with a cut-over (SQLite)', () => {
  let file: string;
  let database: Database;
  let now: number;

  beforeEach(async () => {
    file = await testDatabasePath();
    database = createDatabase(file);
    now = Date.parse('2026-10-21T09:00:00Z');
  });
  afterEach(async () => {
    await database.close();
  });

  const clock = () => new Date(now);
  const writer = (keys: ChainKeyring | null = null) =>
    new SqliteAuditWriter(database.db, clock, null, 3, keys);
  const append = async (w: SqliteAuditWriter, n: number, action = 'test.event') => {
    for (let i = 0; i < n; i++)
      await w.append({
        actorOid: 'u1',
        actorUpn: 'avery@example.com',
        mode: 'read',
        action,
        correlationId: `c-${action}-${now}-${i}`,
        result: 'success',
        details: { i },
      });
  };
  const rows = () => database.sqlite.prepare('select * from audit_events order by seq').all() as Row[];
  /** What someone with write access to the volume can do (the triggers only stop the application). */
  const tamper = (fn: () => void) => {
    database.sqlite.exec('drop trigger audit_events_no_update; drop trigger audit_events_no_delete;');
    fn();
    database.sqlite.exec(triggerStatement('audit_events_no_update'));
    database.sqlite.exec(triggerStatement('audit_events_no_delete'));
  };
  /** Changes event `seq` and re-hashes it and every event after it as SHA-256 — all one can do without the key. */
  const rewriteFrom = (seq: number, details: Record<string, unknown>) =>
    tamper(() => {
      const all = rows();
      let prev = all.filter((r) => r.seq < seq).at(-1)?.hash ?? GENESIS;
      for (const r of all.filter((x) => x.seq >= seq)) {
        const event = { ...eventOf(r), ...(r.seq === seq ? { details } : {}) };
        const hash = chainHash(prev, event);
        database.sqlite
          .prepare('update audit_events set details = ?, prev_hash = ?, hash = ? where seq = ?')
          .run(event.details === null ? null : JSON.stringify(event.details), prev, hash, r.seq);
        prev = hash;
      }
    });
  const logs: Array<{ level: string; obj: object; msg: string }> = [];
  const log = {
    warn: (obj: object, msg: string) => void logs.push({ level: 'warn', obj, msg }),
    info: (obj: object, msg: string) => void logs.push({ level: 'info', obj, msg }),
  };
  /** The API process starting on this file (createContext), then stopping. */
  const start = async (env: Record<string, string> = {}) => {
    logs.length = 0;
    const ctx = createContext(mockConfig({ DATABASE_PATH: file, ...env }), { now: clock }, log);
    await ctx.database?.close();
  };

  it('the API appends the cut-over once per key, after the unkeyed history, and logs it without the key', async () => {
    await append(writer(), 3);
    const before = rows();
    const key = newKey();
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!;

    await start({ AUDIT_CHAIN_KEY: key });
    const after = rows();
    expect(after.slice(0, 3)).toEqual(before);
    expect(after).toHaveLength(4);
    const cut = after[3]!;
    expect(cut).toMatchObject({
      action: CHAIN_KEYED_ACTION,
      actor_oid: 'system',
      prev_hash: before[2]!.hash,
    });
    expect(JSON.parse(cut.details!)).toEqual({ keyId: ring.current.id, previousKeyId: null });
    // The cut-over line carries what `audit verify --checkpoint` needs, and what it chains onto; every start logs the
    // state and the tail (a tail lower than the last one logged means events were removed).
    expect(logs).toEqual([
      {
        level: 'warn',
        obj: {
          seq: cut.seq,
          hash: cut.hash,
          prevHash: before[2]!.hash,
          keyId: ring.current.id,
          previousKeyId: null,
          previousKeyLost: false,
        },
        msg: expect.stringMatching(/^audit chain cut-over/),
      },
      {
        level: 'info',
        obj: { since: cut.seq, keyId: ring.current.id, pinned: false, tailSeq: cut.seq, tailHash: cut.hash },
        msg: 'audit chain keyed',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(key);

    // The next start with the same key appends nothing.
    await start({ AUDIT_CHAIN_KEY: key });
    expect(rows()).toHaveLength(4);
    expect(logs.map((l) => l.msg)).toEqual(['audit chain keyed']);
    expect(await writer(ring).verify()).toMatchObject({ ok: true, count: 4, tail: { seq: cut.seq } });
  });

  it('without a key the API says the chain is unkeyed, and refuses a keyed chain (naming no key)', async () => {
    await start();
    expect(logs).toEqual([{ level: 'warn', obj: {}, msg: expect.stringMatching(/^audit chain unkeyed/) }]);
    expect(rows()).toEqual([]);

    const key = newKey();
    await start({ AUDIT_CHAIN_KEY: key });
    await expect(start()).rejects.toBeInstanceOf(AuditChainKeyError);
    await expect(start()).rejects.toThrow(/keyed from event seq 1 .*AUDIT_CHAIN_KEY is not set/);
    // Another key alone isn't enough either: the lost key must be declared lost (by id).
    await expect(start({ AUDIT_CHAIN_KEY: newKey() })).rejects.toThrow(/AUDIT_CHAIN_LOST_KEY_IDS/);
    const lostId = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!.current.id;
    await start({ AUDIT_CHAIN_KEY: newKey(), AUDIT_CHAIN_LOST_KEY_IDS: lostId });
    expect(rows().filter((r) => r.action === CHAIN_KEYED_ACTION)).toHaveLength(2);
    expect(logs.find((l) => /declared lost/.test(l.msg))).toMatchObject({
      level: 'warn',
      obj: { keyId: lostId },
    });
  });

  it("only the API moves the chain to a key: a one-shot appends with the newest part's key; mock mode logs nothing", async () => {
    await append(writer(), 1);
    logs.length = 0;
    const oneShot = createContext(
      mockConfig({ DATABASE_PATH: file, AUDIT_CHAIN_KEY: newKey() }),
      { now: clock, prepareAuditChain: false },
      log,
    );
    await oneShot.database?.close();
    expect(rows().filter((r) => r.action === CHAIN_KEYED_ACTION)).toEqual([]);
    expect(logs).toEqual([]);
    // In memory there is nothing to anchor: no cut-over line.
    const mock = createContext(mockConfig({ AUDIT_CHAIN_KEY: newKey() }), { now: clock }, log);
    expect(mock.database).toBeNull();
    expect(mock.audit.chainState?.()).toMatchObject({ keyed: true });
    expect(logs).toEqual([]);
  });

  it('AUDIT_CHAIN_KEYED_SINCE: the API refuses to start once the pinned cut-over is gone', async () => {
    const key = newKey();
    await append(writer(), 1);
    await start({ AUDIT_CHAIN_KEY: key });
    await append(writer(chainKeysFrom({ AUDIT_CHAIN_KEY: key })), 2);
    await start({ AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' });
    expect(logs.at(-1)).toMatchObject({ msg: 'audit chain keyed', obj: { since: 2, pinned: true } });
    // The downgrade: the cut-over renamed and everything from it re-hashed as SHA-256.
    tamper(() =>
      database.sqlite.prepare("update audit_events set action = 'audit.renamed' where seq = 2").run(),
    );
    rewriteFrom(2, { keyId: 'x' });
    await expect(start({ AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' })).rejects.toBeInstanceOf(
      AuditChainPinError,
    );
    const pinned = chainKeysFrom({ AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' });
    expect(await writer(pinned).verify()).toMatchObject({ ok: false, seq: 2 });
    // Unpinned, only the shipped log shows it (the known limit): the walk passes, and a start would cut over again.
    expect(await writer(chainKeysFrom({ AUDIT_CHAIN_KEY: key })).verify()).toMatchObject({ ok: true });
  });

  it("the CLI's appends use the newest part's key; without it they are refused and nothing is written or changed", async () => {
    const key = newKey();
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!;
    await append(writer(), 2);
    expect(writer(ring).prepareChain().cutOver?.seq).toBe(3);

    await append(writer(ring), 2, 'content.published');
    expect(await writer(ring).verify()).toMatchObject({ ok: true, count: 5 });

    await expect(append(writer(null), 1)).rejects.toBeInstanceOf(AuditChainKeyError);
    const other = chainKeysFrom({ AUDIT_CHAIN_KEY: newKey() });
    await expect(append(writer(other), 1)).rejects.toThrow(
      /AUDIT_CHAIN_KEY and AUDIT_CHAIN_PREVIOUS_KEYS don't hold/,
    );
    expect(() => writer(null).assertCanAppend()).toThrow(AuditChainKeyError);
    expect(rows()).toHaveLength(5);

    // An emergency sign-out without the key changes nothing it couldn't record.
    const tokens = () => database.sqlite.prepare('select count(*) as n from token_cache').get();
    database.sqlite
      .prepare("insert into token_cache (partition_key, sealed, updated_at) values ('read:x', 's', 1)")
      .run();
    await expect(dbSignOutEveryone({ DATABASE_PATH: file }, () => undefined, { yes: true })).rejects.toThrow(
      AuditChainKeyError,
    );
    expect(tokens()).toEqual({ n: 1 });
    await dbSignOutEveryone({ DATABASE_PATH: file, AUDIT_CHAIN_KEY: key }, () => undefined, { yes: true });
    expect(tokens()).toEqual({ n: 0 });
    expect(await writer(ring).verify()).toMatchObject({ ok: true, count: 6 });
  });

  it('the incremental check verifies across the cut-over, then finds an event rewritten without the key', async () => {
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: newKey() })!;
    await append(writer(), 3);
    const w = writer(ring);
    w.prepareChain();
    await append(w, 2);
    expect(await w.verifyIncremental()).toMatchObject({ ok: true, scope: 'full', count: 6 });
    await append(w, 2);
    now += 3_600_000;
    expect(await w.verifyIncremental()).toMatchObject({
      ok: true,
      scope: 'incremental',
      count: 8,
      checked: 2,
    });

    // Event seq 6 (keyed) changed, it and the rest re-hashed with SHA-256: the walk stops there.
    rewriteFrom(6, { i: 99 });
    expect(await writer(ring).verify()).toMatchObject({ ok: false, seq: 6, brokenAt: 5 });
    now += 3_600_000;
    expect(await w.verifyIncremental()).toMatchObject({ ok: false });
  });

  it('rewriting the unkeyed history before the cut-over is found at the cut-over', async () => {
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: newKey() })!;
    await append(writer(), 3);
    writer(ring).prepareChain();
    expect((await writer(ring).verify()).ok).toBe(true);
    rewriteFrom(2, { i: 42 }); // re-hashes 2, 3 — and the cut-over (4) as SHA-256, which it isn't
    expect(await writer(ring).verify()).toMatchObject({ ok: false, seq: 4 });
  });

  it('rotation: a new key with the old one as previous appends a second cut-over; verification needs both keys', async () => {
    const first = newKey();
    const second = newKey();
    const one = chainKeysFrom({ AUDIT_CHAIN_KEY: first })!;
    await start({ AUDIT_CHAIN_KEY: first });
    await append(writer(one), 2);
    await start({ AUDIT_CHAIN_KEY: second, AUDIT_CHAIN_PREVIOUS_KEYS: first });
    const both = chainKeysFrom({ AUDIT_CHAIN_KEY: second, AUDIT_CHAIN_PREVIOUS_KEYS: first })!;
    const cuts = rows().filter((r) => r.action === CHAIN_KEYED_ACTION);
    expect(cuts.map((r) => JSON.parse(r.details!))).toEqual([
      { keyId: one.current.id, previousKeyId: null },
      { keyId: both.current.id, previousKeyId: one.current.id },
    ]);
    expect(logs.some((l) => /declared lost/.test(l.msg))).toBe(false);
    await append(writer(both), 1);
    expect(await writer(both).verify()).toMatchObject({ ok: true, count: 5 });
    expect(writer(both).chainState()).toEqual({
      keyed: true,
      since: 1,
      keyId: both.current.id,
      keyIdSince: 4,
      pinned: false,
    });
    expect(await writer(chainKeysFrom({ AUDIT_CHAIN_KEY: second })).verify()).toEqual({
      ok: false,
      brokenAt: 0,
      seq: 1,
      missingKey: one.current.id,
    });

    // A process started with the retired key can't take the chain back to it.
    await expect(start({ AUDIT_CHAIN_KEY: first })).rejects.toThrow(
      /already moved on from: since event seq 4/,
    );
  });

  it('a backup of a keyed database verifies only with the key, and neither file holds it', async () => {
    const key = newKey();
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!;
    await append(writer(), 2);
    writer(ring).prepareChain();
    await append(writer(ring), 2);
    const dir = mkdtempSync(path.join(tmpdir(), 'af-keyed-backup-'));

    const copy = await backupDatabase(database, path.join(dir, 'a.db'), { keys: ring });
    expect(copy.audit).toMatchObject({ count: 5, keyed: true, tail: { seq: 5 } });
    await expect(backupDatabase(database, path.join(dir, 'b.db'))).rejects.toThrow(
      /keyed from event #2 \(seq 3\) with a key this command doesn't have/,
    );
    // Reopened later, the copy verifies with the key (and only with it).
    const reopened = createDatabase(copy.file, { readonly: true, pollSignals: false });
    try {
      expect(
        await new SqliteAuditWriter(reopened.db, undefined, null, undefined, ring).verify(),
      ).toMatchObject({
        ok: true,
        count: 5,
      });
      expect(await new SqliteAuditWriter(reopened.db, undefined, null).verify()).toMatchObject({
        ok: false,
        missingKey: ring.current.id,
      });
    } finally {
      await reopened.close();
    }
    const raw = Buffer.from(key, 'base64');
    for (const f of [copy.file, file]) {
      const bytes = readFileSync(f);
      expect(bytes.includes(raw)).toBe(false);
      expect(bytes.includes(Buffer.from(key))).toBe(false);
    }

    // `adminforge db backup`: with the key it says the copy needs it; without, nothing is copied or recorded.
    const lines: string[] = [];
    await dbBackup(
      { DATABASE_PATH: file, AUDIT_CHAIN_KEY: key },
      path.join(dir, 'c.db'),
      { out: (l) => lines.push(l), err: () => undefined },
      { plaintext: true },
    );
    expect(lines.join('\n')).toMatch(/audit chain is keyed: the copy verifies only with AUDIT_CHAIN_KEY/);
    expect(lines.join('\n')).not.toContain(key);
    const recorded = rows().at(-1)!;
    expect(recorded.action).toBe('database.backup');
    expect(JSON.parse(recorded.details!)).toMatchObject({ auditKeyed: true, auditEvents: 5 });
    await expect(
      dbBackup(
        { DATABASE_PATH: file },
        path.join(dir, 'd.db'),
        { out: () => undefined, err: () => undefined },
        {
          plaintext: true,
        },
      ),
    ).rejects.toBeInstanceOf(AuditChainKeyError);
    expect(rows().filter((r) => r.action === 'database.backup')).toHaveLength(1);
    expect(await writer(ring).verify()).toMatchObject({ ok: true, count: 6 });
  });

  it('adminforge audit verify --checkpoint: a re-hashed rewrite passes the walk but not the shipped checkpoint', async () => {
    await append(writer(), 4);
    const shipped = rows()[2]!; // what the API logged: seq 3 and its hash
    const out = async (env: Record<string, string>, checkpoint?: string) => {
      const lines: string[] = [];
      const ok = await auditVerify({ DATABASE_PATH: file, ...env }, (l) => lines.push(l), undefined, {
        ...(checkpoint ? { checkpoint } : {}),
      });
      return { ok, text: lines.join('\n') };
    };
    let r = await out({}, `${shipped.seq}:${shipped.hash}`);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/✓ Checkpoint seq 3 holds/);
    expect(r.text).toMatch(/Unkeyed \(SHA-256\)/);

    rewriteFrom(2, { i: 7 });
    expect((await writer().verify()).ok).toBe(true); // the walk alone can't tell
    r = await out({}, `${shipped.seq}:${shipped.hash}`);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/✓ Audit chain verified/);
    expect(r.text).toMatch(/✗ Checkpoint seq 3 doesn't hold/);
    r = await out({}, `99:${shipped.hash}`);
    expect(r).toMatchObject({
      ok: false,
      text: expect.stringMatching(/✗ Checkpoint seq 99 is not in the chain/),
    });

    // Keyed: the state line names the key's id, never the key; without the key the walk can't vouch for it.
    const key = newKey();
    writer(chainKeysFrom({ AUDIT_CHAIN_KEY: key })).prepareChain();
    r = await out({ AUDIT_CHAIN_KEY: key });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Keyed \(HMAC-SHA256\) from seq 5/);
    expect(r.text).not.toContain(key);
    r = await out({});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(
      /can't be verified from event #4 \(seq 5\): it is keyed with a key this command doesn't have/,
    );
  });

  it('/readyz and Settings say whether the chain is keyed — never the key or its id', async () => {
    const report = async (env: Record<string, string>) => {
      const app = await buildApp(mockConfig({ DATABASE_PATH: file, ...env }));
      try {
        const ready = (await app.inject({ method: 'GET', url: '/readyz' })).json() as {
          checks: Record<string, string>;
        };
        const login = await app.inject({ method: 'GET', url: '/auth/login' });
        const cookie = cookieFrom(login)!;
        await getMe(app, cookie);
        const settings = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } });
        return { ready, settings: settings.json() as { auditChain: unknown }, raw: settings.body };
      } finally {
        await app.close();
      }
    };
    let r = await report({});
    expect(r.ready.checks.auditChain).toBe('unkeyed');
    expect(r.settings.auditChain).toEqual({ keyed: false });

    const key = newKey();
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!;
    r = await report({ AUDIT_CHAIN_KEY: key });
    expect(r.ready.checks.auditChain).toBe('keyed');
    const cut = rows().find((x) => x.action === CHAIN_KEYED_ACTION)!;
    expect(r.settings.auditChain).toEqual({ keyed: true, since: cut.seq, pinned: false });
    expect(r.raw).not.toContain(key);
    expect(r.raw).not.toContain(ring.current.id);
  });
});
