import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import {
  CHAIN_KEYED_ACTION,
  chainHash,
  GENESIS,
  verifyChain,
  walkChain,
  type ChainRow,
} from '@adminforge/api/src/audit/chain';
import {
  ChainKey,
  ChainKeyring,
  chainKeyProblem,
  chainKeyProblems,
  chainKeysFrom,
} from '@adminforge/api/src/audit/keys';
import {
  AuditChainKeyError,
  AuditChainPinError,
  MemoryAuditWriter,
  type AuditRow,
} from '@adminforge/api/src/audit/writer';
import { verifyAudit } from '@adminforge/api/src/admin/audit-query';
import { loadConfig } from '@adminforge/api/src/config';

// S-10: AUDIT_CHAIN_KEY (32 random bytes, base64, in the installation's Secret) turns the audit chain into an HMAC
// chain from a cut-over event on. Events before it keep their SHA-256 links; the cut-over is itself an audited event,
// keyed with the new key, so it also seals the unkeyed history before it. Whoever holds only the database volume can no
// longer change an event and re-hash the chain after it. The key never appears in logs, errors or serialised objects.
const NOW = new Date('2026-10-21T09:00:00.000Z');
const newKey = () => randomBytes(32).toString('base64');

const input = (action: string, i = 0) => ({
  actorOid: 'u1',
  actorUpn: 'avery@example.com',
  mode: 'read' as const,
  action,
  result: 'success' as const,
  correlationId: `c-${action}-${i}`,
  details: { i },
});

const asChain = (rows: AuditRow[]): ChainRow[] => rows.map(({ seq: _seq, ...r }) => r as unknown as ChainRow);

/** A writer on a copy of `rows` with other keys (another process, a later start). */
const reopen = (rows: AuditRow[], env: Parameters<typeof chainKeysFrom>[0] = {}) => {
  const w = new MemoryAuditWriter(() => NOW, chainKeysFrom(env));
  w.rows.push(...structuredClone(rows));
  return w;
};
/** Re-hashes rows `from`…`to` (default: the end) as SHA-256, keeping their links: all someone without the key can do. */
const rehash = (rows: AuditRow[], from: number, to = rows.length) => {
  for (let i = from; i < to; i++) {
    const { seq: _s, prevHash: _p, hash: _h, ...event } = rows[i]!;
    rows[i]!.prevHash = i ? rows[i - 1]!.hash : GENESIS;
    rows[i]!.hash = chainHash(rows[i]!.prevHash, event);
  }
};
const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw');
};

describe('audit chain keys', () => {
  it('accepts exactly 32 random bytes in base64, and says what is wrong without echoing the value', () => {
    expect(chainKeyProblem(newKey())).toBeUndefined();
    for (const bad of [
      'short',
      randomBytes(16).toString('base64'),
      randomBytes(48).toString('base64'),
      `${newKey().slice(0, 43)}!`,
      Buffer.alloc(32, 7).toString('base64'), // one byte repeated: a placeholder, not a key
    ]) {
      const problem = chainKeyProblem(bad);
      expect(problem).toMatch(/32 random bytes, base64|random bytes/);
      expect(problem).not.toContain(bad);
    }
    // Stray padding bits (the last character's two low bits) decode to the same bytes: one spelling per key only.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const k = newKey();
    const sloppy = `${k.slice(0, 42)}${ALPHABET[ALPHABET.indexOf(k[42]!) | 1]}=`;
    expect(Buffer.from(sloppy, 'base64').equals(Buffer.from(k, 'base64'))).toBe(true);
    expect(chainKeyProblem(sloppy)).toMatch(/32 random bytes, base64/);
  });

  it('names a key by an id derived from it; the key itself never serialises, prints or logs', () => {
    const raw = newKey();
    const key = new ChainKey(raw);
    expect(key.id).toMatch(/^[0-9a-f]{16}$/);
    expect(new ChainKey(raw).id).toBe(key.id);
    expect(new ChainKey(newKey()).id).not.toBe(key.id);
    const ring = new ChainKeyring(key, [new ChainKey(newKey())]);
    const bytesHex = Buffer.from(raw, 'base64').toString('hex');
    for (const shown of [
      JSON.stringify({ key, ring }),
      String(key),
      `${ring}`,
      inspect(key, { showHidden: true, depth: 5 }),
      inspect(ring, { showHidden: true, depth: 5 }),
    ]) {
      expect(shown).not.toContain(raw);
      expect(shown).not.toContain(bytesHex);
      expect(shown).toContain(key.id);
    }
    expect(() => new ChainKey('not-a-key')).toThrow(/^The audit chain key must be 32 random bytes/);
  });

  it('builds the keyring from the environment, refusing malformed keys by name', () => {
    expect(chainKeysFrom({})).toBeNull();
    const current = newKey();
    const previous = [newKey(), newKey()];
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: current, AUDIT_CHAIN_PREVIOUS_KEYS: previous.join(', ') })!;
    expect(ring.current.id).toBe(new ChainKey(current).id);
    for (const p of previous) expect(ring.get(new ChainKey(p).id)).toBeDefined();
    expect(chainKeyProblems({ AUDIT_CHAIN_PREVIOUS_KEYS: previous[0] })).toEqual([
      { key: 'AUDIT_CHAIN_PREVIOUS_KEYS', message: expect.stringMatching(/needs AUDIT_CHAIN_KEY/) },
    ]);
    const bad = 'Zm9v';
    expect(() => chainKeysFrom({ AUDIT_CHAIN_KEY: current, AUDIT_CHAIN_PREVIOUS_KEYS: bad })).toThrow(
      /^AUDIT_CHAIN_PREVIOUS_KEYS each entry must be 32 random bytes/,
    );
    try {
      chainKeysFrom({ AUDIT_CHAIN_KEY: bad });
    } catch (err) {
      expect((err as Error).message).not.toContain(bad);
    }
  });

  it('configuration refuses a malformed key (production too), and a key shared with TOKEN_CACHE_KEY', () => {
    const prod = {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://adminforge.example.com',
      AUTH_MODE: 'entra',
      DATABASE_PATH: '/var/lib/adminforge/adminforge.db',
      TOKEN_CACHE_KEY: newKey(),
      AF_TENANT_ID: '11111111-2222-4333-8444-555555555555',
      AF_READ_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
      AF_READ_CLIENT_SECRET: 'synthetic-read-secret',
    };
    expect(loadConfig(prod).AUDIT_CHAIN_KEY).toBeUndefined();
    const key = newKey();
    expect(loadConfig({ ...prod, AUDIT_CHAIN_KEY: key }).AUDIT_CHAIN_KEY).toBe(key);
    const malformed = 'c2hvcnQta2V5LXZhbHVl';
    let message = '';
    try {
      loadConfig({ ...prod, AUDIT_CHAIN_KEY: malformed });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/AUDIT_CHAIN_KEY: must be 32 random bytes, base64/);
    expect(message).not.toContain(malformed);
    expect(() => loadConfig({ ...prod, AUDIT_CHAIN_KEY: prod.TOKEN_CACHE_KEY })).toThrow(
      /AUDIT_CHAIN_KEY: must be a key of its own/,
    );
    expect(() => loadConfig({ ...prod, AUDIT_CHAIN_PREVIOUS_KEYS: newKey() })).toThrow(
      /AUDIT_CHAIN_PREVIOUS_KEYS: needs AUDIT_CHAIN_KEY/,
    );
  });
});

describe('a keyed chain', () => {
  it('HMACs with the key: the same event and link hash differently with and without it', () => {
    const key = new ChainKey(newKey());
    const event = { action: 'x', details: { a: 1 } };
    const plain = chainHash(GENESIS, event);
    const keyed = chainHash(GENESIS, event, key);
    expect(keyed).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed).not.toBe(plain);
    expect(chainHash(GENESIS, event, new ChainKey(newKey()))).not.toBe(keyed);
  });

  it('the cut-over keys itself and everything after it; the unkeyed history before it keeps its links', async () => {
    const writer = new MemoryAuditWriter(() => NOW);
    await writer.append(input('session.signin', 1));
    await writer.append(input('session.armed', 2));
    const before = structuredClone(writer.rows);

    const key = newKey();
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!;
    const keyed = reopen(before, { AUDIT_CHAIN_KEY: key });
    const prepared = keyed.prepareChain();
    expect(prepared.cutOver).toEqual({
      seq: 3,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prevHash: before[1]!.hash,
      keyId: ring.current.id,
      previousKeyId: null,
      previousKeyLost: false,
    });
    expect(prepared.state).toEqual({
      keyed: true,
      since: 3,
      keyId: ring.current.id,
      keyIdSince: 3,
      pinned: false,
    });
    expect(prepared.tail).toEqual({ seq: 3, hash: prepared.cutOver!.hash });
    expect(keyed.rows.slice(0, 2)).toEqual(before);
    const cut = keyed.rows[2]!;
    expect(cut).toMatchObject({
      action: CHAIN_KEYED_ACTION,
      actorOid: 'system',
      targetType: 'audit',
      details: { keyId: ring.current.id, previousKeyId: null },
      prevHash: before[1]!.hash,
    });
    // The cut-over and what follows are HMACs, not SHA-256.
    const { seq: _s, prevHash, hash, ...cutEvent } = cut;
    expect(hash).toBe(chainHash(prevHash, cutEvent, ring.current));
    expect(hash).not.toBe(chainHash(prevHash, cutEvent));
    const after = await keyed.append(input('run.created', 3));
    const { seq: _s2, prevHash: p2, hash: h2, ...afterEvent } = after;
    expect(h2).toBe(chainHash(p2, afterEvent, ring.current));
    expect(await keyed.verify()).toEqual({ ok: true, count: 4, tail: { seq: 4, hash: h2 } });

    // A second start with the same key appends nothing.
    expect(keyed.prepareChain().cutOver).toBeUndefined();
    expect(keyed.rows).toHaveLength(4);
  });

  it('someone without the key can no longer change an event and re-hash the chain after it', async () => {
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: newKey() })!;
    const writer = new MemoryAuditWriter(() => NOW, ring);
    await writer.append(input('session.signin'));
    writer.prepareChain();
    for (let i = 0; i < 3; i++) await writer.append(input('run.step.write', i));
    expect((await writer.verify()).ok).toBe(true);

    // Rewrite event #4 (keyed part) and re-hash everything after it the only way possible without the key: SHA-256.
    const rows = asChain(writer.rows);
    rows[3]!.details = { i: 99 };
    for (let i = 3; i < rows.length; i++) {
      const { prevHash: _p, hash: _h, ...event } = rows[i]!;
      rows[i]!.prevHash = rows[i - 1]!.hash;
      rows[i]!.hash = chainHash(rows[i]!.prevHash, event);
    }
    expect(verifyChain(rows, GENESIS, ring)).toEqual({ ok: false, brokenAt: 3 });

    // Rewriting the unkeyed history before the cut-over breaks the cut-over's link, which needs the key to redo.
    const early = asChain(writer.rows);
    early[0]!.actorUpn = 'someone-else@example.com';
    const { prevHash: _p0, hash: _h0, ...e0 } = early[0]!;
    early[0]!.hash = chainHash(GENESIS, e0);
    expect(verifyChain(early, GENESIS, ring)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('a forged cut-over: an unknown key id is reported (not ok), no key id is a break, and the API refuses to start', async () => {
    const key = newKey();
    const writer = new MemoryAuditWriter(() => NOW, chainKeysFrom({ AUDIT_CHAIN_KEY: key }));
    writer.prepareChain();
    await writer.append(input('run.created'));
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!;
    const rows = asChain(writer.rows);
    // The cut-over's key id swapped for one nobody configured (no re-hash needed): the walk can't vouch for it.
    const forgedId = 'feedfacecafebeef';
    const forged = { ...rows[0]!, details: { keyId: forgedId, previousKeyId: null } };
    expect(walkChain([forged, rows[1]!], undefined, ring)).toMatchObject({
      position: { gap: { index: 0, keyId: forgedId } },
    });
    expect(verifyChain([forged, rows[1]!], GENESIS, ring)).toEqual({
      ok: false,
      brokenAt: 0,
      missingKey: forgedId,
    });
    const tampered = reopen(writer.rows, { AUDIT_CHAIN_KEY: key });
    tampered.rows[0]!.details = { keyId: forgedId, previousKeyId: null };
    // The API doesn't start on it: it would have to move the chain on from a key it doesn't hold.
    const refused = thrown(() => tampered.prepareChain());
    expect(refused).toBeInstanceOf(AuditChainKeyError);
    expect(refused.message).toMatch(/with a key \(id feedfacecafebeef\) that AUDIT_CHAIN_KEY .*was forged/);
    // A cut-over that names no key at all was not written by AdminForge.
    const nameless = { ...rows[0]!, details: { previousKeyId: null } };
    expect(verifyChain([nameless], GENESIS, ring)).toEqual({ ok: false, brokenAt: 0 });
  });

  it('a stretch it has no key for does not hide a later break: the walk goes on and reports the break first', async () => {
    const first = newKey();
    const second = newKey();
    const writer = reopen([], { AUDIT_CHAIN_KEY: first });
    writer.prepareChain();
    await writer.append(input('a'));
    const rotated = reopen(writer.rows, { AUDIT_CHAIN_KEY: second, AUDIT_CHAIN_PREVIOUS_KEYS: first });
    rotated.prepareChain();
    await rotated.append(input('b', 1));
    await rotated.append(input('b', 2));
    // Without the first key: the first part is unverified (links only), the second part still checked.
    const secondOnly = reopen(rotated.rows, { AUDIT_CHAIN_KEY: second });
    expect(await secondOnly.verify()).toEqual({
      ok: false,
      brokenAt: 0,
      seq: 1,
      missingKey: chainKeysFrom({ AUDIT_CHAIN_KEY: first })!.current.id,
    });
    // An event in the part it can check is changed: that is reported, not hidden behind the missing key.
    secondOnly.rows[4]!.details = { i: 99 };
    expect(await secondOnly.verify()).toEqual({ ok: false, brokenAt: 4, seq: 5 });
  });

  it('without the key, a keyed chain is neither extended nor verified, and the error names no key', async () => {
    const raw = newKey();
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: raw })!;
    const keyed = new MemoryAuditWriter(() => NOW, ring);
    await keyed.append(input('session.signin'));
    keyed.prepareChain();
    await keyed.append(input('run.created'));

    const unkeyed = reopen(keyed.rows);
    expect(await unkeyed.verify()).toEqual({ ok: false, brokenAt: 1, seq: 2, missingKey: ring.current.id });
    // The Audit page says "can't verify", not "broken" — without the key's id.
    expect(await verifyAudit(unkeyed)).toEqual({ ok: false, checked: 1, brokenAt: 2, keyMissing: true });
    const refused = thrown(() => unkeyed.prepareChain());
    expect(refused).toBeInstanceOf(AuditChainKeyError);
    expect(refused.message).toMatch(/keyed from event seq 2 .*AUDIT_CHAIN_KEY is not set/);
    expect(refused.message).not.toContain(raw);
    await expect(unkeyed.append(input('x'))).rejects.toBeInstanceOf(AuditChainKeyError);
    expect(unkeyed.rows).toHaveLength(3);
  });

  it('rotation: a new key starts a new keyed part; the old one verifies with the previous key, and only with it', async () => {
    const first = newKey();
    const second = newKey();
    const one = chainKeysFrom({ AUDIT_CHAIN_KEY: first })!;
    const writer = new MemoryAuditWriter(() => NOW, one);
    writer.prepareChain();
    await writer.append(input('a'));

    const both = chainKeysFrom({ AUDIT_CHAIN_KEY: second, AUDIT_CHAIN_PREVIOUS_KEYS: first })!;
    const rotated = reopen(writer.rows, { AUDIT_CHAIN_KEY: second, AUDIT_CHAIN_PREVIOUS_KEYS: first });
    const prepared = rotated.prepareChain();
    expect(prepared.cutOver).toMatchObject({
      seq: 3,
      keyId: both.current.id,
      previousKeyId: one.current.id,
      previousKeyLost: false,
    });
    expect(prepared.state).toEqual({
      keyed: true,
      since: 1,
      keyId: both.current.id,
      keyIdSince: 3,
      pinned: false,
    });
    await rotated.append(input('b'));
    expect(await rotated.verify()).toMatchObject({ ok: true, count: 4 });

    // The new key alone can't vouch for the first part.
    expect(await reopen(rotated.rows, { AUDIT_CHAIN_KEY: second }).verify()).toEqual({
      ok: false,
      brokenAt: 0,
      seq: 1,
      missingKey: one.current.id,
    });
    // Without the previous key the API doesn't move on from it…
    expect(thrown(() => reopen(writer.rows, { AUDIT_CHAIN_KEY: second }).prepareChain())).toBeInstanceOf(
      AuditChainKeyError,
    );
    // …and a process started with the old key can't take the chain back to it.
    const stale = thrown(() => reopen(rotated.rows, { AUDIT_CHAIN_KEY: first }).prepareChain());
    expect(stale.message).toMatch(
      /^Since event seq 3 the audit log names key id .*AUDIT_CHAIN_KEY is a key it already moved on from/,
    );
  });

  it('a lost key: declared by id, the new part starts without it; the walk accepts that stretch as links only — no other', async () => {
    const lostKey = newKey();
    const next = newKey();
    const lostId = chainKeysFrom({ AUDIT_CHAIN_KEY: lostKey })!.current.id;
    const writer = reopen([], { AUDIT_CHAIN_KEY: lostKey });
    await writer.append(input('before'));
    writer.prepareChain();
    await writer.append(input('a'));

    const recovered = reopen(writer.rows, { AUDIT_CHAIN_KEY: next, AUDIT_CHAIN_LOST_KEY_IDS: lostId });
    expect(recovered.prepareChain().cutOver).toMatchObject({
      seq: 4,
      previousKeyId: lostId,
      previousKeyLost: true,
    });
    expect(recovered.rows[3]!.details).toEqual({
      keyId: chainKeysFrom({ AUDIT_CHAIN_KEY: next })!.current.id,
      previousKeyId: lostId,
      previousKeyLost: true,
      previousKeyFrom: recovered.rows[1]!.prevHash,
    });
    await recovered.append(input('b'));
    expect(await recovered.verify()).toEqual({
      ok: true,
      count: 5,
      tail: { seq: 5, hash: recovered.rows[4]!.hash },
      lostKey: { seq: 2, keyId: lostId },
    });

    // A forged cut-over naming the lost key later on is not covered by that declaration.
    const later = reopen(recovered.rows, { AUDIT_CHAIN_KEY: next });
    later.rows[4]!.action = CHAIN_KEYED_ACTION;
    later.rows[4]!.details = { keyId: lostId, previousKeyId: null };
    expect(await later.verify()).toMatchObject({ ok: false, seq: 5, missingKey: lostId });
  });

  it('AUDIT_CHAIN_KEYED_SINCE pins the first cut-over: renaming it and re-hashing as SHA-256 no longer passes', async () => {
    const key = newKey();
    const writer = reopen([], { AUDIT_CHAIN_KEY: key });
    await writer.append(input('before'));
    writer.prepareChain();
    await writer.append(input('a'));
    // The downgrade: the cut-over renamed, everything from it re-hashed as SHA-256. Unpinned, the walk can't tell.
    const downgraded = structuredClone(writer.rows);
    downgraded[1]!.action = 'audit.renamed';
    rehash(downgraded, 1);
    expect(await reopen(downgraded, { AUDIT_CHAIN_KEY: key }).verify()).toMatchObject({ ok: true });
    // Pinned at seq 2, it fails — in the walk and at the API's start.
    const pinned = reopen(downgraded, { AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' });
    expect(await pinned.verify()).toEqual({ ok: false, brokenAt: 1, seq: 2 });
    const refused = thrown(() => pinned.prepareChain());
    expect(refused).toBeInstanceOf(AuditChainPinError);
    expect(refused.message).toMatch(
      /keyed from event seq 2 \(AUDIT_CHAIN_KEYED_SINCE\), but that event is not the cut-over/,
    );
    // Cut short before the pin: also refused.
    const short = reopen(writer.rows.slice(0, 1), { AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' });
    expect(await short.verify()).toEqual({ ok: false, brokenAt: 1, seq: 2 });
    // A cut-over at the pinned seq that names an unknown key, or was changed, doesn't pass at start either.
    const renamed = reopen(writer.rows, { AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' });
    renamed.rows[1]!.details = { keyId: 'feedfacecafebeef', previousKeyId: null };
    expect(thrown(() => renamed.prepareChain())).toMatchObject({
      reason: 'unverified',
      keyId: 'feedfacecafebeef',
    });
    const edited = reopen(writer.rows, { AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' });
    edited.rows[1]!.actorUpn = 'someone@example.com';
    expect(thrown(() => edited.prepareChain())).toMatchObject({ reason: 'unverified' });
    expect(() => edited.assertCanAppend()).toThrow(AuditChainPinError);
    // The real chain, pinned: fine, and Settings says so.
    const intact = reopen(writer.rows, { AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEYED_SINCE: '2' });
    expect(intact.prepareChain().state).toMatchObject({ keyed: true, since: 2, pinned: true });
    expect(await intact.verify()).toMatchObject({ ok: true, count: 3 });
  });

  describe('a lost-key declaration covers its own stretch and no other', () => {
    // seq 1–2 unkeyed · 3 cut-over to P · 4–5 P · 6 cut-over to L · 7 L · 8 cut-over to K declaring L lost.
    const P = newKey();
    const L = newKey();
    const K = newKey();
    const id = (k: string) => chainKeysFrom({ AUDIT_CHAIN_KEY: k })!.current.id;
    const env = { AUDIT_CHAIN_KEY: K, AUDIT_CHAIN_PREVIOUS_KEYS: P };
    const build = async () => {
      const p = reopen([], { AUDIT_CHAIN_KEY: P });
      await p.append(input('u', 1));
      await p.append(input('u', 2));
      p.prepareChain();
      await p.append(input('p', 4));
      await p.append(input('p', 5));
      const l = reopen(p.rows, { AUDIT_CHAIN_KEY: L, AUDIT_CHAIN_PREVIOUS_KEYS: P });
      l.prepareChain();
      await l.append(input('l', 7));
      const k = reopen(l.rows, { ...env, AUDIT_CHAIN_LOST_KEY_IDS: id(L) });
      expect(k.prepareChain().cutOver).toMatchObject({ seq: 8, previousKeyLost: true });
      expect(k.rows[7]!.details).toMatchObject({ previousKeyFrom: k.rows[5]!.prevHash });
      return k.rows;
    };

    it('the declared stretch: ok, links only', async () => {
      expect(await reopen(await build(), env).verify()).toMatchObject({
        ok: true,
        lostKey: { seq: 6, keyId: id(L) },
      });
    });

    it('stretching it back over the history before (the earlier cut-over renamed to the lost key) is caught', async () => {
      const rows = await build();
      // Rewrite the unkeyed events and re-hash just them (SHA-256); seq 3–7 are links-only once seq 3 names L.
      rows[0]!.details = { i: 666 };
      rehash(rows, 0, 2);
      rows[2]!.prevHash = rows[1]!.hash;
      rows[2]!.details = { keyId: id(L), previousKeyId: null }; // seq 3 now names L
      rows[3]!.details = { i: 4444 };
      rows[5]!.action = 'audit.renamed'; // seq 6 is no longer a cut-over
      expect(await reopen(rows, env).verify()).toMatchObject({ ok: false, seq: 3, missingKey: id(L) });
    });

    it('pinned: a pinned cut-over renamed to the lost key is refused at start, even with the lost id still set', async () => {
      const rows = await build();
      rows[2]!.details = { keyId: id(L), previousKeyId: null };
      const tampered = reopen(rows, {
        ...env,
        AUDIT_CHAIN_LOST_KEY_IDS: id(L),
        AUDIT_CHAIN_KEYED_SINCE: '3',
      });
      expect(thrown(() => tampered.prepareChain())).toMatchObject({ reason: 'unverified', keyId: id(L) });
    });

    it('a second unknown cut-over inside the verifiable part is not covered either', async () => {
      const rows = await build();
      rows[4]!.action = CHAIN_KEYED_ACTION; // seq 5 forged as a cut-over to an unknown key
      rows[4]!.details = { keyId: 'f1f1f1f1f1f1f1f1', previousKeyId: id(P) };
      expect(await reopen(rows, env).verify()).toMatchObject({
        ok: false,
        seq: 5,
        missingKey: 'f1f1f1f1f1f1f1f1',
      });
    });
  });

  it('a pinned first cut-over whose key was lost: accepted when it is being declared, and once it was', async () => {
    const L = newKey();
    const K = newKey();
    const lId = chainKeysFrom({ AUDIT_CHAIN_KEY: L })!.current.id;
    const l = reopen([], { AUDIT_CHAIN_KEY: L });
    await l.append(input('u'));
    l.prepareChain();
    await l.append(input('l'));
    const env = { AUDIT_CHAIN_KEY: K, AUDIT_CHAIN_LOST_KEY_IDS: lId, AUDIT_CHAIN_KEYED_SINCE: '2' };
    const k = reopen(l.rows, env);
    expect(k.prepareChain().cutOver).toMatchObject({ seq: 4, previousKeyLost: true });
    expect(reopen(k.rows, env).prepareChain().cutOver).toBeUndefined();
    expect(await reopen(k.rows, env).verify()).toMatchObject({ ok: true, lostKey: { seq: 2, keyId: lId } });
  });

  it('a forged cut-over before a genuine rotation is reported where it is, not at the rotation', async () => {
    const P = newKey();
    const K = newKey();
    const p = reopen([], { AUDIT_CHAIN_KEY: P });
    p.prepareChain();
    await p.append(input('p', 2));
    await p.append(input('p', 3));
    const k = reopen(p.rows, { AUDIT_CHAIN_KEY: K, AUDIT_CHAIN_PREVIOUS_KEYS: P });
    k.prepareChain();
    k.rows[1]!.action = CHAIN_KEYED_ACTION;
    k.rows[1]!.details = { keyId: 'f1f1f1f1f1f1f1f1', previousKeyId: null };
    expect(await reopen(k.rows, { AUDIT_CHAIN_KEY: K, AUDIT_CHAIN_PREVIOUS_KEYS: P }).verify()).toEqual({
      ok: false,
      brokenAt: 1,
      seq: 2,
    });
  });

  it('a verified cut-over can only move on: back to a key the chain already left is a break', async () => {
    const P = newKey();
    const K = newKey();
    const p = reopen([], { AUDIT_CHAIN_KEY: P });
    p.prepareChain();
    const k = reopen(p.rows, { AUDIT_CHAIN_KEY: K, AUDIT_CHAIN_PREVIOUS_KEYS: P });
    k.prepareChain();
    await k.append(input('k'));
    // Someone holding the old key P (leaked, still in AUDIT_CHAIN_PREVIOUS_KEYS) appends a cut-over back to it.
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: K, AUDIT_CHAIN_PREVIOUS_KEYS: P })!;
    const pId = chainKeysFrom({ AUDIT_CHAIN_KEY: P })!.current.id;
    const event = {
      ...k.rows[0]!,
      seq: 4,
      correlationId: 'forged',
      details: { keyId: pId, previousKeyId: ring.current.id },
    };
    const { seq: _s, prevHash: _p, hash: _h, ...hashed } = event;
    const prevHash = k.rows[2]!.hash;
    k.rows.push({ ...event, prevHash, hash: chainHash(prevHash, hashed, ring.get(pId)) });
    expect(await reopen(k.rows, { AUDIT_CHAIN_KEY: K, AUDIT_CHAIN_PREVIOUS_KEYS: P }).verify()).toEqual({
      ok: false,
      brokenAt: 3,
      seq: 4,
    });
  });

  it('an unkeyed chain without a key stays as it is (the portal works as before)', async () => {
    const writer = new MemoryAuditWriter(() => NOW);
    expect(writer.prepareChain()).toEqual({ state: { keyed: false } });
    const row = await writer.append(input('a'));
    const { seq: _s, prevHash, hash, ...event } = row;
    expect(hash).toBe(chainHash(prevHash, event));
    expect(writer.chainState()).toEqual({ keyed: false });
  });
});
