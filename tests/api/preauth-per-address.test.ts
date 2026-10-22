import { addressHash } from '@adminforge/api/src/auth/flow';
import {
  MemoryPreauthStore,
  PREAUTH_TTL_MS,
  SqlitePreauthStore,
  signinBusy,
  type PreauthRecord,
  type PreauthStore,
} from '@adminforge/api/src/auth/preauth-store';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { Clock } from '../lib/clock';
import { resetTables, testDatabasePath } from './db';
import { entraConfig, FakeAuthClient } from './helpers';
import { buildTestApp } from './support/app';

// Every anonymous sign-in start writes a pending sign-in, and a global cap bounds them (S-28). A few addresses, each
// within its own rate limit, could fill the table within the two minutes a pending sign-in is protected and refuse
// everyone else (2026-10-22 review). When the table is full, the address holding the most pending sign-ins now gives
// up its oldest — whatever their age — if it holds more than the starting address; otherwise the age rule decides
// as before. People sharing an address (an office NAT) are never cut short by a flood from elsewhere, and an address
// can't evict one no heavier than itself.
const T0 = Date.parse('2026-10-22T08:00:00Z');
let n = 0;
const record = (ip: string | null, at = T0, sessionIdHash: string | null = null): PreauthRecord => ({
  state: `s-${n++}`,
  kind: sessionIdHash ? 'write' : 'read',
  verifier: 'v',
  nonce: 'n',
  returnTo: '/',
  sessionIdHash,
  bindingHash: 'b',
  addressHash: ip ? addressHash(ip) : null,
  details: null,
  expiresAt: new Date(at + PREAUTH_TTL_MS),
});

const file = await testDatabasePath();
let database: Database;
beforeAll(() => {
  database = createDatabase(file);
});
afterAll(() => database.close());

const stores: Array<[string, () => PreauthStore & { size(): number }]> = [
  [
    'memory',
    () => {
      const s = new MemoryPreauthStore({ maxPending: 20 });
      return Object.assign(s, { size: () => s.rows.size });
    },
  ],
  [
    'sqlite',
    () => {
      resetTables(database);
      const s = new SqlitePreauthStore(database.db, { maxPending: 20 });
      return Object.assign(s, {
        size: () => (database.sqlite.prepare('select count(*) as n from preauth').get() as { n: number }).n,
      });
    },
  ],
];
const busy = signinBusy().code;
const put = (store: PreauthStore, r: PreauthRecord) =>
  store.put(r).then(
    () => 'started',
    (e: { code?: string }) => e.code,
  );

describe.each(stores)('a full table makes room from the heaviest address (%s store)', (_name, make) => {
  it('lets someone else sign in while nine addresses flood the table', async () => {
    const store = make();
    const outcomes: string[] = [];
    for (let i = 0; i < 9 * 10; i++)
      outcomes.push((await put(store, record(`198.51.100.${(i % 9) + 1}`, T0 + i))) ?? '');
    expect(store.size()).toBe(20);
    expect(outcomes).toContain(busy); // the flooders themselves are refused once the table is full
    expect(await put(store, record('192.0.2.10', T0 + 100))).toBe('started');
    expect(store.size()).toBe(20);
  });

  it('takes the room from the heaviest address only', async () => {
    const store = make();
    const light = [record('192.0.2.7', T0), record('192.0.2.7', T0 + 1)];
    for (const r of light) await put(store, r);
    const heavy = Array.from({ length: 18 }, (_, i) => record('198.51.100.1', T0 + 2 + i));
    for (const r of heavy) await put(store, r);
    expect(await put(store, record('192.0.2.99', T0 + 30))).toBe('started');
    expect(await store.take(heavy[0]!.state)).toBeNull();
    for (const r of light) expect(await store.take(r.state)).not.toBeNull();
  });

  it('doesn’t let an address evict one no heavier than itself', async () => {
    const store = make();
    for (let i = 0; i < 10; i++) await put(store, record('198.51.100.1', T0 + i));
    for (let i = 0; i < 10; i++) await put(store, record('198.51.100.2', T0 + 10 + i));
    expect(await put(store, record('198.51.100.1', T0 + 30))).toBe(busy);
    expect(store.size()).toBe(20);
  });

  it('leaves arming alone', async () => {
    const store = make();
    for (let i = 0; i < 25; i++) await put(store, record('198.51.100.1', T0 + i, `session-${i}`));
    expect(store.size()).toBe(25);
  });
});

describe('sign-in start', () => {
  it('records a pseudonymous key for its address, the same across one IPv6 /64', async () => {
    expect(addressHash('2001:db8:1:2::1')).toBe(addressHash('2001:db8:1:2:ffff::9'));
    expect(addressHash('2001:db8:1:3::1')).not.toBe(addressHash('2001:db8:1:2::1'));
    expect(addressHash('198.51.100.23')).toMatch(/^[0-9a-f]{64}$/);
    const clock = new Clock();
    const auth = new FakeAuthClient();
    auth.now = clock.now;
    const preauth = new MemoryPreauthStore();
    const t = await buildTestApp(entraConfig(), { clock, deps: { auth, preauth } });
    const res = await t.app.inject({
      method: 'GET',
      url: '/auth/login?returnTo=%2F',
      remoteAddress: '198.51.100.23',
    });
    expect(res.statusCode).toBe(302);
    expect([...preauth.rows.values()][0]!.addressHash).toBe(addressHash('198.51.100.23'));
    await t.app.close();
  });
});
