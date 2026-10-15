import type { ContentError, DefinitionOf, Kind } from '@adminforge/schemas';
import type { Config } from '../config';
import type { Database } from '../db/client';
import { AppError } from '../errors';
import { DbDefinitionStore, DEFINITIONS_CHANNEL } from './db-store';
import { FsDefinitionSource } from './fs-source';
import { PgListener } from './notify';
import {
  recordKey,
  type ChangeListener,
  type DefinitionRecord,
  type DefinitionRegistry,
  type DefinitionsChanged,
  type DefinitionSource,
  type ResolvedDefinition,
} from './types';

type Log = { info?(obj: object, msg: string): void; warn(obj: object, msg: string): void };

export const definitionNotFound = (kind: string, key: string, version?: string) =>
  new AppError(
    404,
    'definition_not_found',
    `No published ${kind} "${key}"${version ? ` version ${version}` : ''}.`,
    {
      hint: version
        ? 'The version may never have been published.'
        : 'Check the id, or publish the content (adminforge publish).',
    },
  );

/**
 * Published definitions from Postgres with an in-process cache. `NOTIFY definitions_changed` (from any publisher, any
 * replica) drops the affected entries; a (re)connect of the listener drops everything, since notifications sent while
 * disconnected are lost.
 */
export class CachedDbSource implements DefinitionSource {
  private readonly cache = new Map<string, Promise<DefinitionRecord | null>>();
  private readonly lists = new Map<string, Promise<DefinitionRecord[]>>();
  private readonly listeners = new Set<ChangeListener>();
  private listener: PgListener | null = null;

  constructor(
    readonly store: DbDefinitionStore,
    opts: { listenUrl?: string; log?: Log } = {},
  ) {
    if (opts.listenUrl) {
      let first = true;
      this.listener = new PgListener(
        opts.listenUrl,
        DEFINITIONS_CHANNEL,
        (payload) => this.invalidate(parseChange(payload)),
        {
          log: opts.log,
          onConnect: () => {
            if (!first) this.invalidate({ all: true });
            first = false;
          },
        },
      );
      void this.listener.start();
    }
  }

  /** Drops cached entries and tells listeners (SSE, datasource cache). */
  invalidate(change: DefinitionsChanged): void {
    if (change.all || !change.keys) this.cache.clear();
    else
      for (const k of change.keys)
        for (const ck of [...this.cache.keys()])
          if (ck === k || ck.startsWith(`${k}@`)) this.cache.delete(ck);
    this.lists.clear();
    for (const l of this.listeners) l(change);
  }

  private memo<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let p = map.get(key);
    if (!p) {
      p = load();
      map.set(key, p);
      // Never cache failures.
      p.catch(() => map.delete(key));
    }
    return p;
  }

  list(kind?: Kind): Promise<DefinitionRecord[]> {
    return this.memo(this.lists, kind ?? '*', () => this.store.list(kind));
  }

  get(kind: Kind, key: string, version?: string): Promise<DefinitionRecord | null> {
    return this.memo(this.cache, `${recordKey(kind, key)}${version ? `@${version}` : ''}`, () =>
      this.store.get(kind, key, version),
    );
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  problems(): ContentError[] {
    return [];
  }

  async close(): Promise<void> {
    await this.listener?.stop();
    this.listeners.clear();
  }
}

function parseChange(payload: string): DefinitionsChanged {
  try {
    const v = JSON.parse(payload) as DefinitionsChanged;
    if (v && (v.all === true || Array.isArray(v.keys)))
      return v.all ? { all: true } : { keys: v.keys!.filter((k) => typeof k === 'string') };
  } catch {
    // fall through
  }
  return { all: true };
}

/** Wraps a source with the DefinitionResolver port. */
export function registryFrom(source: DefinitionSource, origin: 'fs' | 'db'): DefinitionRegistry {
  const resolve = async <K extends Kind>(
    kind: K,
    key: string,
    version?: string,
  ): Promise<ResolvedDefinition<DefinitionOf<K>>> => {
    const r = await source.get(kind, key, version);
    if (!r) throw definitionNotFound(kind, key, version);
    return { def: r.def as DefinitionOf<K>, version: r.version, sha256: r.sha256 };
  };
  return {
    origin,
    list: (kind) => source.list(kind),
    get: (kind, key, version) => source.get(kind, key, version),
    onChange: (l) => source.onChange(l),
    problems: () => source.problems(),
    close: () => source.close(),
    resolve,
    async resolveAny<K extends Kind>(kinds: readonly K[], key: string, version?: string) {
      for (const kind of kinds) {
        const r = await source.get(kind, key, version);
        if (r) return { def: r.def as DefinitionOf<K>, version: r.version, sha256: r.sha256, kind };
      }
      throw definitionNotFound(kinds.join('/'), key, version);
    },
  };
}

/** CONTENT_SOURCE=db without a database: the app still boots; content requests fail with a clear 503. */
function unavailableSource(): DefinitionSource {
  const fail = async (): Promise<never> => {
    throw new AppError(
      503,
      'content_unavailable',
      'Published content is not available: CONTENT_SOURCE=db but no database is connected.',
      {
        hint: 'Set DATABASE_URL, or CONTENT_SOURCE=fs for development.',
      },
    );
  };
  return {
    list: fail,
    get: fail,
    onChange: () => () => undefined,
    problems: () => [],
    close: async () => undefined,
  };
}

/** CONTENT_SOURCE=fs → portal/content (hot reload when CONTENT_WATCH); db → published versions + LISTEN/NOTIFY. */
export function createDefinitionRegistry(
  config: Pick<Config, 'CONTENT_SOURCE' | 'CONTENT_DIR' | 'CONTENT_WATCH' | 'DATABASE_URL'>,
  database: Database | null,
  log?: Log,
): DefinitionRegistry {
  if (config.CONTENT_SOURCE === 'db') {
    if (!database) return registryFrom(unavailableSource(), 'db');
    return registryFrom(
      new CachedDbSource(new DbDefinitionStore(database.db), { listenUrl: config.DATABASE_URL, log }),
      'db',
    );
  }
  return registryFrom(new FsDefinitionSource(config.CONTENT_DIR, { watch: config.CONTENT_WATCH, log }), 'fs');
}
