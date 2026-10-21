import { createHash } from 'node:crypto';
import { CHAIN_KEY_ID, type ChainKey, type ChainKeys } from './keys';

/** prev_hash of the first event. */
export const GENESIS = '0'.repeat(64);

/**
 * The event that starts a keyed part of the chain (S-10): `details.keyId` names the key, and this event and every one
 * after it are HMAC-SHA256 with that key, up to the next such event (a new key). Before the first one the chain is
 * SHA-256: the events written before the installation had a key keep their links. There is no way back to SHA-256 —
 * a walk that has the key refuses an unkeyed event after a keyed one, so dropping the key can't hide a rewrite.
 */
export const CHAIN_KEYED_ACTION = 'audit.chain_keyed';

/** Deterministic JSON: object keys sorted, `undefined` members dropped, `null` kept. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

/** hash = sha256(prev_hash || "\n" || canonical(event)); in a keyed part, HMAC-SHA256(key, the same bytes). */
export function chainHash(prevHash: string, event: Record<string, unknown>, key?: ChainKey | null): string {
  const input = `${prevHash}\n${canonical(event)}`;
  return key ? key.mac(input) : createHash('sha256').update(input).digest('hex');
}

/** The key id a cut-over event names, or undefined when it isn't a cut-over or names none AdminForge would write. */
export function cutOverKeyId(event: { action?: unknown; details?: unknown }): string | undefined {
  if (event.action !== CHAIN_KEYED_ACTION) return undefined;
  const id = (event.details as { keyId?: unknown } | null | undefined)?.keyId;
  return typeof id === 'string' && CHAIN_KEY_ID.test(id) ? id : undefined;
}

export type ChainRow = Record<string, unknown> & { prevHash: string; hash: string };

/** Where a walk stands: the last hash, and the key id of the part it is in (null: the unkeyed part). */
export interface ChainPosition {
  hash: string;
  keyId: string | null;
  /** The key ids of the keyed parts verified so far: no later cut-over may go back to one. */
  used?: readonly string[];
  /**
   * Inside a stretch keyed with a key this walk doesn't have: where it started (event index), the key its first
   * cut-over names, the verified hash it chains onto (`from`) and how many cut-overs it holds. Its links are still
   * checked. It counts as lost (links only) only when the cut-over that ends it is verified and declares exactly that:
   * this key, chained onto this hash, lost — which only the holder of the new key can write. Otherwise it stays
   * unverified.
   */
  gap?: { index: number; keyId: string; from: string; cutOvers: number };
}

export const CHAIN_START: ChainPosition = { hash: GENESIS, keyId: null };

/** A stretch of events the walk couldn't re-hash (no key for it): where it starts, and the key it names. */
export interface ChainGap {
  index: number;
  keyId: string;
}

export interface ChainWalk {
  /** Where the walk ended (or stopped). */
  position: ChainPosition;
  /** The index of the first event that doesn't verify (changed, removed, or a cut-over AdminForge didn't write). */
  brokenAt?: number;
  /** The first stretch keyed with a key the walk doesn't have that no later cut-over declared lost. */
  missing?: ChainGap;
  /** The first stretch keyed with a key the next cut-over declared lost (AUDIT_CHAIN_LOST_KEY_IDS): links only. */
  lost?: ChainGap;
}

/** What a cut-over records about the part before it (chain.ts walks, writer.ts writes). */
export interface CutOverDetails {
  keyId: string;
  previousKeyId: string | null;
  /** The previous key was declared lost (AUDIT_CHAIN_LOST_KEY_IDS)… */
  previousKeyLost?: true;
  /** …and its part's cut-over chained onto this hash: the declaration covers that stretch and no other. */
  previousKeyFrom?: string;
}

const detailsOf = (event: { details?: unknown }) =>
  (event.details ?? {}) as Partial<Record<keyof CutOverDetails, unknown>>;

/**
 * Re-walks rows in order from `from` (`offset`: the index of the first row in the whole chain). Each event must link
 * to the one before it and re-hash to its hash with the key of its part, and each verified cut-over must move on from
 * the part before it to a key not used before; the walk stops at the first that doesn't. A stretch keyed with a key it
 * doesn't have is checked for links only and reported (`missing`, or `lost` when the cut-over that ends it declares
 * that very stretch lost); an unfinished one stays in `position.gap` for the caller.
 */
export function walkChain(
  rows: readonly ChainRow[],
  from: ChainPosition = CHAIN_START,
  keys: ChainKeys | null = null,
  offset = 0,
): ChainWalk {
  let at = from;
  let missing: ChainGap | undefined;
  let lost: ChainGap | undefined;
  const result = (brokenAt?: number): ChainWalk => ({
    position: at,
    ...(brokenAt !== undefined ? { brokenAt } : {}),
    ...(missing ? { missing } : {}),
    ...(lost ? { lost } : {}),
  });
  for (const [i, row] of rows.entries()) {
    const index = offset + i;
    const { prevHash, hash, ...event } = row;
    if (prevHash !== at.hash) return result(index);
    const cut = event.action === CHAIN_KEYED_ACTION;
    let keyId = at.keyId;
    if (cut) {
      const id = cutOverKeyId(event);
      // A cut-over without a key id was not written by AdminForge.
      if (!id) return result(index);
      keyId = id;
    }
    const key = keyId ? keys?.get(keyId) : null;
    if (keyId && !key) {
      at = {
        hash,
        keyId,
        ...(at.used ? { used: at.used } : {}),
        gap: at.gap
          ? { ...at.gap, cutOvers: at.gap.cutOvers + (cut ? 1 : 0) }
          : { index, keyId, from: at.hash, cutOvers: cut ? 1 : 0 },
      };
      continue;
    }
    if (chainHash(at.hash, event, key) !== hash) return result(index);
    if (cut) {
      const d = detailsOf(event);
      // It names the part it ends, and never takes the chain back to a key it already left. A stretch it couldn't
      // verify that ends wrong is reported where that stretch starts (a forged cut-over), not at this genuine one.
      if ((d.previousKeyId ?? null) !== at.keyId || at.used?.includes(keyId!))
        return result(at.gap ? at.gap.index : index);
      if (at.gap) {
        const declared =
          d.previousKeyLost === true &&
          d.previousKeyId === at.gap.keyId &&
          d.previousKeyFrom === at.gap.from &&
          at.gap.cutOvers === 1;
        const gap = { index: at.gap.index, keyId: at.gap.keyId };
        if (declared) lost ??= gap;
        else missing ??= gap;
      }
      at = { hash, keyId, used: [...(at.used ?? []), keyId!] };
    } else at = { hash, keyId, ...(at.used ? { used: at.used } : {}) };
  }
  return result();
}

/** Re-walks a chain in order; reports the index of the first row that doesn't verify (or can't be). */
export function verifyChain(
  rows: readonly ChainRow[],
  genesis = GENESIS,
  keys: ChainKeys | null = null,
): { ok: true } | { ok: false; brokenAt: number; missingKey?: string } {
  const r = walkChain(rows, { hash: genesis, keyId: null }, keys);
  if (r.brokenAt !== undefined) return { ok: false, brokenAt: r.brokenAt };
  const missing = r.missing ?? r.position.gap;
  return missing ? { ok: false, brokenAt: missing.index, missingKey: missing.keyId } : { ok: true };
}
