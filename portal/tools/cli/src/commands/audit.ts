/**
 * `adminforge audit verify [--checkpoint <seq>:<hash>] [--env <name>]` — re-walks the tamper-evident audit log's hash
 * chain in the database file at DATABASE_PATH and reports whether every event still links to the one before it (the
 * API's SqliteAuditWriter does the walk; this command only prints the verdict). In the pod: `kubectl exec
 * deploy/adminforge -c api -- adminforge audit verify`.
 *
 * Keyed chains (S-10): from the cut-over event on, events are HMAC-SHA256 with AUDIT_CHAIN_KEY, so the walk needs the
 * key (and, after a rotation, the earlier ones in AUDIT_CHAIN_PREVIOUS_KEYS) — the pod's environment has them.
 *
 * --checkpoint: a line the API logged ("audit chain checkpoint" or "audit chain cut-over", shipped off the cluster)
 * names a seq and the hash the chain had there. The event at that seq must still have that hash: re-hashing a
 * rewritten unkeyed chain makes the walk pass, but can't reproduce the hash the log already holds.
 *
 * Read-only: opens the file read-only, writes nothing, nothing in the tenant. Exit code 1 when the chain is broken,
 * can't be verified, or the checkpoint doesn't hold.
 */
import {
  chainKeyProblems,
  chainKeysFrom,
  createDatabase,
  SqliteAuditWriter,
  type ChainKeyring,
  type ChainState,
  type Checkpoint,
  type CheckpointVerdict,
  type VerifyResult,
} from '../content/api-bridge';
import { databasePath } from '../shared/database-path';
import { ConfigError } from '../shared/errors';
import type { Out } from '../shared/output';

/** The audit chain a verify walks (injected in tests; default: the database file at DATABASE_PATH). */
export interface AuditChain {
  verify(): Promise<VerifyResult>;
  /** The walk plus a checkpoint from the shipped log (`--checkpoint`). */
  verifyCheckpoint?(cp: Checkpoint): Promise<{ chain: VerifyResult; checkpoint: CheckpointVerdict }>;
  /** Whether the chain is keyed, and since which event. */
  state?(): ChainState;
  close(): Promise<void>;
}

/**
 * The audit chain keys from the environment (AUDIT_CHAIN_KEY, AUDIT_CHAIN_PREVIOUS_KEYS), or null without them. Every
 * command that walks or appends to the chain uses them; a malformed key is refused by name, never echoed.
 */
export function auditChainKeys(env: Record<string, string | undefined>): ChainKeyring | null {
  const problems = chainKeyProblems(env);
  if (problems.length) throw new ConfigError(problems.map((p) => `${p.key} ${p.message}.`).join(' '));
  return chainKeysFrom(env);
}

function openAuditChain(file: string, keys: ChainKeyring | null): AuditChain {
  const database = createDatabase(file, { readonly: true, name: 'cli' });
  // The verdict is printed here; the API's own verifications write the checkpoint lines to its log.
  const writer = new SqliteAuditWriter(database.db, undefined, null, undefined, keys);
  return {
    verify: () => writer.verify(),
    verifyCheckpoint: (cp) => writer.verifyCheckpoint(cp),
    state: () => writer.chainState(),
    close: () => database.close(),
  };
}

const CHECKPOINT = /^(\d{1,15}):([0-9a-f]{64})$/i;

/** `<seq>:<hash>` as the API's log lines give them. */
export function parseCheckpoint(value: string): Checkpoint {
  const m = CHECKPOINT.exec(value.trim());
  if (!m || Number(m[1]) < 1)
    throw new ConfigError(
      `--checkpoint takes <seq>:<hash> from an "audit chain checkpoint" or "audit chain cut-over" line in the api container's log (seq a positive number, hash 64 hexadecimal characters).`,
    );
  return { seq: Number(m[1]), hash: m[2]!.toLowerCase() };
}

const IN_THE_POD = 'kubectl exec deploy/adminforge -c api -- adminforge audit verify';

/** The verdict line(s) for a walk. */
function chainLines(result: VerifyResult): string[] {
  if (result.ok)
    return [`✓ Audit chain verified: ${result.count} event(s), every hash links to the one before it.`];
  if (result.missingKey)
    return [
      `✗ Audit chain can't be verified from event #${result.brokenAt} (seq ${result.seq}): it is keyed with a key this command doesn't have (key id ${result.missingKey}). Run it where AUDIT_CHAIN_KEY is set (in the pod: ${IN_THE_POD}); after a rotation, the earlier key goes in AUDIT_CHAIN_PREVIOUS_KEYS. If no key with that id was ever configured, the event was forged: investigate who had write access to the volume.`,
    ];
  return [
    `✗ Audit chain broken at event #${result.brokenAt} (seq ${result.seq}): that row or one before it was changed or removed. Restore from a backup and investigate who had write access to the volume.`,
  ];
}

function stateLine(state: ChainState): string {
  if (!state.keyed)
    return "  Unkeyed (SHA-256): whoever can write the volume can rewrite and re-hash it; only the shipped checkpoints show it. Set AUDIT_CHAIN_KEY in the installation's Secret (docs/operations.md → Audit chain checkpoints).";
  const key = `Current key id ${state.keyId}, since seq ${state.keyIdSince}.`;
  return state.pinned
    ? `  Keyed (HMAC-SHA256) from seq ${state.since}, pinned (AUDIT_CHAIN_KEYED_SINCE): changing a keyed event, or removing the keyed part, fails this check; events removed from the end show only against the shipped checkpoints. ${key}`
    : `  Keyed (HMAC-SHA256) from seq ${state.since}: changing a keyed event needs the key. Removed events — from the end, or the whole keyed part — show only against the shipped checkpoints, unless AUDIT_CHAIN_KEYED_SINCE pins seq ${state.since}. ${key}`;
}

function checkpointLine(cp: Checkpoint, verdict: CheckpointVerdict): string {
  switch (verdict) {
    case 'holds':
      return `✓ Checkpoint seq ${cp.seq} holds: the event there still has the hash the API logged, so the history up to it is unchanged.`;
    case 'changed':
      return `✗ Checkpoint seq ${cp.seq} doesn't hold: the event there has another hash than the API logged, so the history up to it was rewritten. Restore from a backup and investigate who had write access to the volume.`;
    case 'missing':
      return `✗ Checkpoint seq ${cp.seq} is not in the chain: events up to it were removed (or the chain was cut short). Restore from a backup and investigate who had write access to the volume.`;
    case 'unverified':
      return `✗ Checkpoint seq ${cp.seq} can't be checked: the chain fails before it (above).`;
  }
}

/**
 * Re-walks the hash chain, and with `checkpoint` (`<seq>:<hash>`) checks it against the shipped log. Returns true when
 * every event links to the one before it (and the checkpoint holds).
 */
export async function auditVerify(
  env: Record<string, string | undefined>,
  out: Out,
  open: (file: string, keys: ChainKeyring | null) => AuditChain = openAuditChain,
  opts: { checkpoint?: string } = {},
): Promise<boolean> {
  // Everything that can be refused is refused before the database is opened.
  const checkpoint = opts.checkpoint !== undefined ? parseCheckpoint(opts.checkpoint) : undefined;
  const file = databasePath(env);
  const keys = auditChainKeys(env);
  const chain = open(file, keys);
  try {
    let result: VerifyResult;
    let verdict: CheckpointVerdict | undefined;
    if (checkpoint) {
      if (!chain.verifyCheckpoint) throw new ConfigError('This audit chain cannot check checkpoints.');
      ({ chain: result, checkpoint: verdict } = await chain.verifyCheckpoint(checkpoint));
    } else result = await chain.verify();
    for (const line of chainLines(result)) out(line);
    const state = chain.state?.();
    if (result.ok) {
      if (state) out(stateLine(state));
      if (result.lostKey)
        out(
          `  The events from seq ${result.lostKey.seq} up to the cut-over that declared their key lost (id ${result.lostKey.keyId}) are checked for links only: their contents can't be verified any more.`,
        );
      // The external anchor: the "audit chain checkpoint" lines the API logged must agree with this chain.
      if (result.tail && !checkpoint)
        out(
          `  Tail: seq ${result.tail.seq}, hash ${result.tail.hash}. Compare with the checkpoints the API logged (the audit-chain probe and the Audit page write them): adminforge audit verify --checkpoint <seq>:<hash> with one from your log store's copy of the api container's log, or kubectl logs deploy/adminforge -c api | grep 'audit chain checkpoint'.`,
        );
    }
    if (checkpoint && verdict) out(checkpointLine(checkpoint, verdict));
    return result.ok && (!checkpoint || verdict === 'holds');
  } finally {
    await chain.close();
  }
}
