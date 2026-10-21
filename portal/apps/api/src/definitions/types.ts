import type { ContentError, Definition, DefinitionOf, Kind } from '@adminforge/schemas';

/** Where a definition came from: `fs` = portal/content on disk (dev), `git`/`portal` = published rows in the database. */
export type DefinitionOrigin = 'fs' | 'git' | 'portal';

/** One version of one definition. */
export interface DefinitionRecord<D extends Definition = Definition> {
  kind: D['kind'];
  key: string;
  version: string;
  /** sha256 of the source file text (runs pin version + sha256). */
  sha256: string;
  def: D;
  /** `retired` versions stay resolvable by exact version (runs, audit) but are never the "latest". */
  status: 'published' | 'retired';
  source: DefinitionOrigin;
  /** fs: path relative to the content dir. */
  file?: string;
  publishedAt?: Date | null;
  /** Database rows: the content schema version the row was published under (its body passed the current one). */
  schemaVersion?: number;
}

/** What a run or a datasource pins: the definition plus its version and content hash. */
export interface ResolvedDefinition<D extends Definition = Definition> {
  def: D;
  version: string;
  sha256: string;
}

/**
 * The port the runs worker, the scheduler and the datasource executor resolve content through.
 * `version` omitted → the latest published (non-retired) version. Throws AppError 404 `definition_not_found`.
 */
export interface DefinitionResolver {
  resolve<K extends Kind>(
    kind: K,
    key: string,
    version?: string,
  ): Promise<ResolvedDefinition<DefinitionOf<K>>>;
}

/**
 * Payload of the `definitions_changed` signal and of change listeners. Keys are `kind:key`. Browsers (the SSE
 * `definitions.changed` event) only ever get `{all: true}` — events/bus.ts.
 */
export interface DefinitionsChanged {
  keys?: string[];
  all?: boolean;
}

export type ChangeListener = (change: DefinitionsChanged) => void;

/** Read side of the registry (fs or db). */
export interface DefinitionSource {
  /** Latest non-retired record per key, optionally of one kind. */
  list(kind?: Kind): Promise<DefinitionRecord[]>;
  /** Exact version (published or retired), or the latest non-retired version. */
  get(kind: Kind, key: string, version?: string): Promise<DefinitionRecord | null>;
  /**
   * The latest version of `key` when that version is retired — null when the key has a current version or was never
   * published — so someone asking for it hears "retired, and why" instead of "not found". Optional for test doubles.
   */
  retired?(kind: Kind, key: string): Promise<DefinitionRecord | null>;
  onChange(listener: ChangeListener): () => void;
  /** Content problems found while loading (fs: files that don't validate; db: published rows refused on load). */
  problems(): ContentError[];
  close(): Promise<void>;
}

export interface DefinitionRegistry extends DefinitionSource, DefinitionResolver {
  readonly origin: 'fs' | 'db';
  /** First match across kinds (pages: page | dashboard | report). */
  resolveAny<K extends Kind>(
    kinds: readonly K[],
    key: string,
    version?: string,
  ): Promise<ResolvedDefinition<DefinitionOf<K>> & { kind: K }>;
}

export const recordKey = (kind: string, key: string) => `${kind}:${key}`;

interface SemVerParts {
  nums: [number, number, number];
  pre: string[];
}

function parseSemVer(v: string): SemVerParts {
  const [core = '', pre] = v.split('+')[0]!.split(/-(.*)/s);
  const nums = core.split('.').map((n) => Number(n) || 0);
  return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre ? pre.split('.') : [] };
}

/** Semver precedence: negative when a < b. */
export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! - pb.nums[i]!;
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== undefined) return -1;
    else if (ny !== undefined) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
