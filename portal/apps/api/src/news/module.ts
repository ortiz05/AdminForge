import { createFixtureFetch } from '@adminforge/connectors';
import type { AppContext } from '../context';
import type { HostLookup } from '../probes/addresses';
import { fetchFeed } from './fetch-feed';
import { MemoryNewsStore } from './memory-store';
import { SqliteNewsStore } from './sqlite-store';
import { NewsService } from './service';
import type { NewsStore } from './types';

export interface NewsOptions {
  store?: NewsStore;
  /** fetch for public feeds (default: fixtures in DATA_MODE=fixtures, else the context's fetch). */
  fetch?: typeof fetch;
  lookup?: HostLookup;
  feedTimeoutMs?: number;
}

/**
 * DATA_MODE=fixtures never resolves or reaches the internet: feeds come from tests/fixtures/hosts/<host>/…. The stand-in
 * answer is a public address so the same address check live feeds go through still runs (documentation ranges such as
 * 192.0.2.0/24 are refused as non-public); the fixture fetch never opens a socket.
 */
const FIXTURE_LOOKUP: HostLookup = async () => ['1.1.1.1'];

/** News and changes: Postgres store when a database is configured (memory otherwise), collectors on the context. */
export function createNewsService(
  ctx: AppContext,
  opts: NewsOptions = {},
  log?: { warn(obj: object, msg: string): void },
): NewsService {
  const fixtures = ctx.config.DATA_MODE === 'fixtures';
  const fetchImpl =
    opts.fetch ?? (fixtures ? createFixtureFetch(ctx.config.ADMINFORGE_FIXTURES_DIR) : ctx.fetch);
  const lookup = opts.lookup ?? (fixtures ? FIXTURE_LOOKUP : undefined);
  return new NewsService({
    store: opts.store ?? (ctx.database ? new SqliteNewsStore(ctx.database) : new MemoryNewsStore()),
    definitions: ctx.definitions,
    collectors: {
      outbound: ctx.outbound,
      fetchFeed: (url, o) => fetchFeed(url, { fetch: fetchImpl, ...(lookup ? { lookup } : {}) }, o),
      now: ctx.now,
    },
    now: ctx.now,
    ...(log ? { log } : {}),
    ...(opts.feedTimeoutMs ? { feedTimeoutMs: opts.feedTimeoutMs } : {}),
  });
}
