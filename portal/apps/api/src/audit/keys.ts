/**
 * The audit chain key (S-10): AUDIT_CHAIN_KEY, 32 random bytes, base64, kept in the installation's Secret — never on
 * the database volume. With a key, the audit log is HMAC-SHA256 from a cut-over event on (chain.ts), so whoever holds
 * only the volume (a snapshot, a restored copy, another pod that mounts it) can't change an event and re-hash the chain
 * after it: that needs the key. It doesn't stop the API process, which holds the key.
 *
 * - Rotation: a new AUDIT_CHAIN_KEY, with the old one in AUDIT_CHAIN_PREVIOUS_KEYS so the events it keyed still verify;
 *   the API appends a new cut-over at its next start.
 * - A lost key: its id in AUDIT_CHAIN_LOST_KEY_IDS lets the API start a new keyed part without it; the cut-over says the
 *   key was lost, so walks accept that stretch as links-only — and nothing else they can't verify.
 * - AUDIT_CHAIN_KEYED_SINCE pins the seq of the first cut-over: removing or renaming it (and re-hashing what follows as
 *   SHA-256) then fails verification and stops the API from starting, without the shipped log.
 *
 * A key never leaves its ChainKey: the object keeps only the MAC key derived from it, computes MACs, and prints, logs
 * and serialises as its id only.
 */
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';

/** `openssl rand -base64 32`: 43 base64 characters and one `=`. */
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Two keys derived from the configured one (HMAC as the KDF), one per use: the id names the key (cut-over events, logs,
 * `adminforge audit verify`), the MAC key chains the events. Neither reveals the key.
 */
const KEY_ID_LABEL = 'adminforge audit chain key id';
const MAC_KEY_LABEL = 'adminforge audit chain mac key v1';

/** What a key id looks like in a cut-over event. */
export const CHAIN_KEY_ID = /^[0-9a-f]{16}$/;

/** What is wrong with a key's value — words for a configuration error, never the value — or undefined when it is usable. */
export function chainKeyProblem(value: string): string | undefined {
  const v = value.trim();
  const bytes = Buffer.from(v, 'base64');
  // Re-encoding catches stray padding bits: one key has exactly one spelling.
  if (!BASE64_32.test(v) || bytes.length !== 32 || bytes.toString('base64') !== v)
    return 'must be 32 random bytes, base64 (openssl rand -base64 32)';
  if (bytes.every((b) => b === bytes[0]))
    return 'must be random bytes, not one byte repeated (openssl rand -base64 32)';
  return undefined;
}

/** One audit chain key. Only the MAC key derived from it is kept, in a private field: only `mac` uses it. */
export class ChainKey {
  readonly id: string;
  readonly #macKey: Buffer;

  /** Throws (without the value) when `base64` isn't a usable key: check it with `chainKeyProblem` first. */
  constructor(base64: string) {
    const problem = chainKeyProblem(base64);
    if (problem) throw new Error(`The audit chain key ${problem}.`);
    const key = Buffer.from(base64.trim(), 'base64');
    this.id = createHmac('sha256', key).update(KEY_ID_LABEL).digest('hex').slice(0, 16);
    this.#macKey = createHmac('sha256', key).update(MAC_KEY_LABEL).digest();
    key.fill(0);
  }

  /** HMAC-SHA256 of `data` with this key's MAC key, hex. */
  mac(data: string): string {
    return createHmac('sha256', this.#macKey).update(data).digest('hex');
  }

  toJSON() {
    return { id: this.id };
  }
  toString() {
    return `ChainKey(${this.id})`;
  }
  [inspect.custom]() {
    return this.toString();
  }
}

/** Finds a key by its id (a cut-over names the key of its part). */
export interface ChainKeys {
  get(id: string): ChainKey | undefined;
}

/** The configuration around the keys (ids and a seq — nothing secret). */
export interface ChainKeyOptions {
  /** Ids of keys that are lost (AUDIT_CHAIN_LOST_KEY_IDS): the API may start a new keyed part without them. */
  lost?: readonly string[];
  /** The seq of the first cut-over (AUDIT_CHAIN_KEYED_SINCE): it must still be there. */
  keyedSince?: number | null;
}

/** The configured keys: `current` keys new events; it and the previous ones verify. */
export class ChainKeyring implements ChainKeys {
  readonly #byId = new Map<string, ChainKey>();
  readonly lost: ReadonlySet<string>;
  readonly keyedSince: number | null;

  constructor(
    readonly current: ChainKey,
    previous: readonly ChainKey[] = [],
    opts: ChainKeyOptions = {},
  ) {
    for (const k of [current, ...previous]) if (!this.#byId.has(k.id)) this.#byId.set(k.id, k);
    this.lost = new Set(opts.lost ?? []);
    this.keyedSince = opts.keyedSince ?? null;
  }

  get(id: string): ChainKey | undefined {
    return this.#byId.get(id);
  }

  toJSON() {
    return { current: this.current.id, keys: [...this.#byId.keys()] };
  }
  toString() {
    return `ChainKeyring(${[...this.#byId.keys()].join(', ')})`;
  }
  [inspect.custom]() {
    return this.toString();
  }
}

/** The configuration keys. */
export interface ChainKeyEnv {
  AUDIT_CHAIN_KEY?: string | undefined;
  AUDIT_CHAIN_PREVIOUS_KEYS?: string | undefined;
  AUDIT_CHAIN_LOST_KEY_IDS?: string | undefined;
  AUDIT_CHAIN_KEYED_SINCE?: string | undefined;
}

type ChainKeyName = keyof ChainKeyEnv & string;

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

/** What is wrong with the keys and their options, per configuration key (names and words only, never values). */
export function chainKeyProblems(env: ChainKeyEnv): Array<{ key: ChainKeyName; message: string }> {
  const out: Array<{ key: ChainKeyName; message: string }> = [];
  const current = env.AUDIT_CHAIN_KEY?.trim();
  const currentProblem = current ? chainKeyProblem(current) : undefined;
  if (currentProblem) out.push({ key: 'AUDIT_CHAIN_KEY', message: currentProblem });
  const previous = list(env.AUDIT_CHAIN_PREVIOUS_KEYS);
  if (previous.some((k) => chainKeyProblem(k)))
    out.push({
      key: 'AUDIT_CHAIN_PREVIOUS_KEYS',
      message: 'each entry must be 32 random bytes, base64 (comma-separated)',
    });
  if (list(env.AUDIT_CHAIN_LOST_KEY_IDS).some((id) => !CHAIN_KEY_ID.test(id)))
    out.push({
      key: 'AUDIT_CHAIN_LOST_KEY_IDS',
      message:
        'each entry must be a key id as the audit log names it: 16 hexadecimal characters (comma-separated)',
    });
  const since = env.AUDIT_CHAIN_KEYED_SINCE?.trim();
  if (since && !/^[1-9]\d{0,14}$/.test(since))
    out.push({
      key: 'AUDIT_CHAIN_KEYED_SINCE',
      message: 'must be the seq of the first "audit chain cut-over" (a positive whole number)',
    });
  if (!current)
    for (const key of [
      'AUDIT_CHAIN_PREVIOUS_KEYS',
      'AUDIT_CHAIN_LOST_KEY_IDS',
      'AUDIT_CHAIN_KEYED_SINCE',
    ] as const)
      if (env[key]?.trim())
        out.push({ key, message: 'needs AUDIT_CHAIN_KEY too (the key new audit events are chained with)' });
  return out;
}

/**
 * The keyring from AUDIT_CHAIN_KEY and its options, or null without a key (the chain stays SHA-256). Throws, naming the
 * configuration key and never the value, when one is malformed.
 */
export function chainKeysFrom(env: ChainKeyEnv): ChainKeyring | null {
  const problems = chainKeyProblems(env);
  if (problems.length) throw new Error(problems.map((p) => `${p.key} ${p.message}`).join('; '));
  const current = env.AUDIT_CHAIN_KEY?.trim();
  if (!current) return null;
  const since = env.AUDIT_CHAIN_KEYED_SINCE?.trim();
  return new ChainKeyring(
    new ChainKey(current),
    list(env.AUDIT_CHAIN_PREVIOUS_KEYS).map((k) => new ChainKey(k)),
    { lost: list(env.AUDIT_CHAIN_LOST_KEY_IDS), keyedSince: since ? Number(since) : null },
  );
}
