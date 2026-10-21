import { randomBytes } from 'node:crypto';
import type { ChainKeyring } from '@adminforge/api/src/audit/keys';
import type { CheckpointVerdict, VerifyResult } from '@adminforge/api/src/audit/writer';
import {
  auditChainKeys,
  auditVerify,
  parseCheckpoint,
  type AuditChain,
} from '@adminforge/cli/src/commands/audit';
import { ConfigError } from '@adminforge/cli/src/shared/errors';

// `adminforge audit verify --checkpoint <seq>:<hash>` (S-10): the API logs "audit chain checkpoint" lines (and the
// cut-over) to the api container's log, which is shipped off the cluster. Re-hashing a rewritten unkeyed chain makes
// the walk pass; the checkpoint shows it, because the event at that seq no longer has the hash the log holds. A keyed
// chain needs AUDIT_CHAIN_KEY from the environment; the command says so, and never prints a key.
const DB = '/var/lib/adminforge/adminforge.db';
const HASH = 'ab'.repeat(32);

function chain(result: VerifyResult, verdict: CheckpointVerdict = 'holds', keyed = false) {
  const calls = { opened: 0, checkpoints: [] as unknown[], keys: [] as Array<ChainKeyring | null> };
  const open = (_file: string, keys: ChainKeyring | null): AuditChain => {
    calls.opened++;
    calls.keys.push(keys);
    return {
      verify: async () => result,
      verifyCheckpoint: async (cp) => {
        calls.checkpoints.push(cp);
        return { chain: result, checkpoint: verdict };
      },
      state: () =>
        keyed
          ? { keyed: true, since: 120, keyId: '0123456789abcdef', keyIdSince: 300, pinned: false }
          : { keyed: false },
      close: async () => undefined,
    };
  };
  return { open, calls };
}

const run = async (
  c: ReturnType<typeof chain>,
  opts: { checkpoint?: string } = {},
  env: Record<string, string> = {},
) => {
  const lines: string[] = [];
  const ok = await auditVerify({ DATABASE_PATH: DB, ...env }, (l) => lines.push(l), c.open, opts);
  return { ok, lines, text: lines.join('\n') };
};

describe('adminforge audit verify --checkpoint', () => {
  it('parses <seq>:<hash> as the log gives it, and refuses anything else before opening the database', async () => {
    expect(parseCheckpoint(`1234:${HASH.toUpperCase()}`)).toEqual({ seq: 1234, hash: HASH });
    for (const bad of [
      '1234',
      `0:${HASH}`,
      `-1:${HASH}`,
      `12:${HASH.slice(2)}`,
      `x:${HASH}`,
      `12:${HASH}:3`,
    ]) {
      const c = chain({ ok: true, count: 1 });
      await expect(run(c, { checkpoint: bad })).rejects.toThrow(ConfigError);
      await expect(run(c, { checkpoint: bad })).rejects.toThrow(/--checkpoint takes <seq>:<hash>/);
      expect(c.calls.opened).toBe(0);
    }
  });

  it('a checkpoint that holds: exit 0, and the checkpoint is checked, not just the walk', async () => {
    const c = chain({ ok: true, count: 500, tail: { seq: 500, hash: HASH } });
    const r = await run(c, { checkpoint: `42:${HASH}` });
    expect(r.ok).toBe(true);
    expect(c.calls.checkpoints).toEqual([{ seq: 42, hash: HASH }]);
    expect(r.lines[0]).toMatch(/^✓ Audit chain verified: 500 event\(s\)/);
    expect(r.text).toMatch(/✓ Checkpoint seq 42 holds: .*history up to it is unchanged/);
  });

  it.each([
    ['changed', /✗ Checkpoint seq 42 doesn't hold: .*rewritten/],
    ['missing', /✗ Checkpoint seq 42 is not in the chain: .*removed/],
  ] as const)('a checkpoint that %s fails even when the walk passes', async (verdict, line) => {
    const r = await run(chain({ ok: true, count: 9 }, verdict), { checkpoint: `42:${HASH}` });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/^✓ Audit chain verified/);
    expect(r.text).toMatch(line);
  });

  it('a chain broken before the checkpoint: both say so', async () => {
    const r = await run(chain({ ok: false, brokenAt: 3, seq: 4 }, 'unverified'), {
      checkpoint: `42:${HASH}`,
    });
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual([
      expect.stringMatching(/^✗ Audit chain broken at event #3 \(seq 4\)/),
      expect.stringMatching(/^✗ Checkpoint seq 42 can't be checked/),
    ]);
  });

  it('keyed: says from where, by key id; unkeyed: says how to key it', async () => {
    let r = await run(chain({ ok: true, count: 400 }, 'holds', true));
    expect(r.text).toMatch(
      /Keyed \(HMAC-SHA256\) from seq 120: .*Current key id 0123456789abcdef, since seq 300\./,
    );
    r = await run(chain({ ok: true, count: 400 }, 'holds', false));
    expect(r.text).toMatch(/Unkeyed \(SHA-256\): .*Set AUDIT_CHAIN_KEY in the installation's Secret/);
  });

  it('a keyed part it has no key for: not verified (exit 1), and how to run it where the key is', async () => {
    const r = await run(chain({ ok: false, brokenAt: 119, seq: 120, missingKey: '0123456789abcdef' }));
    expect(r.ok).toBe(false);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(
      /^✗ Audit chain can't be verified from event #119 \(seq 120\): it is keyed with a key this command doesn't have \(key id 0123456789abcdef\)\. Run it where AUDIT_CHAIN_KEY is set \(in the pod: kubectl exec/,
    );
  });

  it('passes the keys from the environment to the walk, refuses malformed ones by name, never prints them', async () => {
    const key = randomBytes(32).toString('base64');
    const c = chain({ ok: true, count: 1 }, 'holds', true);
    const r = await run(c, {}, { AUDIT_CHAIN_KEY: key });
    expect(c.calls.keys[0]?.current.id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.text).not.toContain(key);
    expect(auditChainKeys({})).toBeNull();
    const bad = 'bm90LWEta2V5';
    const refused = chain({ ok: true, count: 1 });
    await expect(run(refused, {}, { AUDIT_CHAIN_KEY: bad })).rejects.toThrow(
      /^AUDIT_CHAIN_KEY must be 32 random bytes, base64/,
    );
    await expect(run(refused, {}, { AUDIT_CHAIN_KEY: bad })).rejects.not.toThrow(bad);
    expect(refused.calls.opened).toBe(0);
  });
});
