import { randomUUID } from 'node:crypto';
import type { HumanTask } from '@adminforge/engine';
import { SqlitePreauthStore } from '@adminforge/api/src/auth/preauth-store';
import { SqliteSessionStore } from '@adminforge/api/src/auth/session-store';
import { createTokenCache, SqliteSealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import type { Config } from '@adminforge/api/src/config';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { InProcessRunQueue, SqliteRunRepository, type NewRun } from '@adminforge/api/src/runs';
import {
  armMock,
  gate,
  hashOf,
  OPERATOR,
  respond,
  rotationDefinitions,
  TAP,
  USER,
  waitFor,
} from './arm-rotate-helpers';
import { testDatabasePath } from './db';
import {
  bindingCookie,
  cookieFrom,
  entraConfig,
  FakeAuthClient,
  getMe,
  mockConfig,
  orgResponse,
  TEST_KEY,
} from './helpers';
import { ALL_ROLES, AVERY, BLAKE, FakeExecutor } from './runs-helpers';
import { buildTestApp, sessionFor } from './support/app';
import type { TestPerson } from './support/people';
import { Clock } from '../lib/clock';

// S-08 on SQLite: arming moves the session to a new id in ONE immediate transaction — the session row, its unfinished
// runs and their approval decisions, the round trips it started and its token partitions (sealed again under the new
// partition key) — so the old id stops working at once and nothing is left half-moved.

const file = await testDatabasePath();
const KEY = Buffer.from(TEST_KEY, 'base64');
const RESET = [
  'delete from run_jobs',
  'delete from leases',
  'delete from runs',
  "delete from approvals where subject_type = 'run'",
  'delete from sessions',
  'delete from preauth',
  'delete from token_cache',
].join('; ');

/** The API with every store on the database file (the app gets its own connection: it closes it). */
async function dbApp(
  o: { config?: Config; auth?: FakeAuthClient; hold?: Record<string, Promise<void>> } = {},
) {
  const appDb = createDatabase(file);
  const clock = new Clock();
  const outbound = new FakeExecutor(respond(o.hold));
  const queue = new InProcessRunQueue(undefined, 10);
  const repository = new SqliteRunRepository(appDb, clock.now);
  const sessions = new SqliteSessionStore(appDb.db);
  const tokenCache = createTokenCache(new SqliteSealedBlobStore(appDb.db), KEY);
  if (o.auth) {
    o.auth.now = clock.now;
    o.auth.cache = tokenCache;
  }
  const { app, audit } = await buildTestApp(o.config ?? mockConfig({ DATABASE_PATH: file }), {
    clock,
    deps: {
      database: appDb,
      sessions,
      preauth: new SqlitePreauthStore(appDb.db),
      tokenCache,
      ...(o.auth ? { auth: o.auth, fetch: async () => orgResponse() } : {}),
      runs: { definitions: rotationDefinitions(), outbound, queue, repository, sweep: false },
    },
  });
  await app.ready();
  return {
    app,
    clock,
    audit,
    outbound,
    repository,
    sessions,
    tokenCache,
    runs: app.runs,
    login: (user: TestPerson, roles: string[], opts: { armed?: boolean } = {}) =>
      sessionFor({ app, sessions, clock }, user, roles, opts),
    drain: () => queue.drain(),
  };
}

const newRun = (sessionHash: string, status: NewRun['status'], initiator = AVERY): NewRun => ({
  id: randomUUID(),
  kind: 'playbook',
  definitionKey: 'test.tap-approved',
  definitionVersion: '1.0.0',
  definitionSha256: 'a'.repeat(64),
  dryRun: false,
  trigger: 'interactive',
  identity: 'delegated',
  identityName: null,
  initiatorOid: initiator.oid,
  initiatorUpn: initiator.upn,
  sessionHash,
  scheduleId: null,
  parentRunId: null,
  inputs: {},
  correlationId: randomUUID(),
  status,
});

const approval: HumanTask = {
  kind: 'approval',
  path: 'ok',
  stepId: 'ok',
  message: 'ok?',
  approvers: ['Playbook.Approver'],
  minApprovals: 2,
  expiresAt: null,
  requestedBy: { kind: 'delegated', ...BLAKE },
};

describe('arming rotates the session id (SQLite)', () => {
  let db: Database;
  beforeAll(() => {
    db = createDatabase(file);
  });
  beforeEach(() => {
    db.sqlite.exec(RESET);
  });
  afterAll(async () => {
    db.sqlite.exec(RESET);
    await db.close();
  });

  const rows = <T>(query: string, ...args: unknown[]) => db.sqlite.prepare(query).all(...args) as T[];
  /** Whose session the first decision on run `id`'s task is bound to. */
  const decidedBy = (id: string) => {
    const [row] = rows<{ decisions: string }>('select decisions from approvals where subject_id = ?', id);
    return (JSON.parse(row!.decisions) as Array<{ sessionHash: string }>)[0]!.sessionHash;
  };

  it('moves the row, unfinished runs and their decisions, round trips and token partitions in one transaction', async () => {
    const t = await dbApp();
    const avery = await t.login(AVERY, ALL_ROLES);
    const from = avery.record.idHash;
    const open = await t.repository.insertRun(newRun(from, 'awaiting_approval', BLAKE));
    const done = await t.repository.insertRun(newRun(from, 'succeeded', BLAKE));
    const others = await t.repository.insertRun(newRun('someone-else', 'awaiting_approval', BLAKE));
    for (const run of [open, done]) {
      const task = await t.repository.upsertTask(run.id, approval, { kind: 'approval' } as never);
      await t.repository.updateTask(task.id, {
        decisions: [
          {
            oid: AVERY.oid,
            upn: AVERY.upn,
            decision: 'approve',
            sessionHash: from,
            at: t.clock.now().toISOString(),
          },
        ],
      });
    }
    db.sqlite
      .prepare(
        `insert into preauth (state, kind, verifier, nonce, return_to, session_id_hash, created_at, expires_at)
         values ('schedule-consent-state', 'schedule', 'v', 'n', '/', ?, ?, ?)`,
      )
      .run(from, t.clock.t, t.clock.t + 600_000);
    await t.tokenCache.set(`read:${from}`, '{"account":"read"}');
    const [sealedBefore] = rows<{ sealed: string }>('select sealed from token_cache');

    const armed = await armMock(t.app, avery.headers);
    const to = hashOf(armed.cookie);

    expect(rows('select id_hash from sessions')).toEqual([{ id_hash: to }]);
    const hashOfRun = (id: string) =>
      rows<{ session_hash: string }>('select session_hash from runs where id = ?', id)[0]!.session_hash;
    // The session was read-only: a run bound to it reads on through the new id, but asks before writing (prearm).
    expect([hashOfRun(open.id), hashOfRun(done.id), hashOfRun(others.id)]).toEqual([
      `prearm:${to}`,
      from,
      'someone-else',
    ]);
    expect([decidedBy(open.id), decidedBy(done.id)]).toEqual([to, from]);
    expect(rows('select session_id_hash from preauth')).toEqual([{ session_id_hash: to }]);
    const tokens = rows<{ partition_key: string; sealed: string }>(
      'select partition_key, sealed from token_cache',
    );
    expect(tokens.map((r) => r.partition_key)).toEqual([`read:${to}`]);
    expect(tokens[0]!.sealed).not.toBe(sealedBefore!.sealed);
    expect(await t.tokenCache.get(`read:${to}`)).toBe('{"account":"read"}');

    expect((await getMe(t.app, avery.headers.cookie)).res.statusCode).toBe(401);
    expect((await getMe(t.app, armed.cookie)).me!.mode).toBe('armed');

    // Arming again while armed gains nothing new: a run bound to the armed id moves as it is, a prearm one stays so.
    const later = await t.repository.insertRun(newRun(to, 'running'));
    const again = await armMock(t.app, armed.headers);
    const third = hashOf(again.cookie);
    expect([hashOfRun(open.id), hashOfRun(later.id)]).toEqual([`prearm:${third}`, third]);
    expect(decidedBy(open.id)).toBe(third);
    await t.app.close();
  });

  it('a mover that fails rolls everything back: nothing moved, the old id keeps working', async () => {
    const t = await dbApp();
    const avery = await t.login(AVERY, ALL_ROLES);
    const from = avery.record.idHash;
    const run = await t.repository.insertRun(newRun(from, 'awaiting_arm'));
    await t.tokenCache.set(`read:${from}`, '{"account":"read"}');
    // Registered last: every other mover has already written inside the transaction when this one throws.
    t.sessions.onRotate({
      moveSessionTx: () => {
        throw new Error('disk full');
      },
    });

    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/arm',
      headers: avery.headers,
      payload: { minutes: 30, reason: 'Disable a test user' },
    });
    expect(res.statusCode).toBe(500);
    expect(cookieFrom(res)).toBeUndefined();
    expect(rows('select id_hash from sessions')).toEqual([{ id_hash: from }]);
    expect(rows('select session_hash from runs where id = ?', run.id)).toEqual([{ session_hash: from }]);
    expect(rows('select partition_key from token_cache')).toEqual([{ partition_key: `read:${from}` }]);
    expect(await t.tokenCache.get(`read:${from}`)).toBe('{"account":"read"}');
    expect((await getMe(t.app, avery.headers.cookie)).me!.mode).toBe('read');
    expect(t.audit.rows.some((r) => r.action === 'session.armed')).toBe(false);
    await t.app.close();
  });

  it('an in-flight run keeps working, and a held show-once secret is fetched with the new cookie only', async () => {
    const first = gate();
    const t = await dbApp({ hold: { '/users/first': first.opened } });
    const avery = await t.login(AVERY, OPERATOR, { armed: true });
    const reads = (
      await avery.post('/api/runs', { playbook: 'test.two-reads', inputs: { userId: USER } })
    ).json();
    await waitFor(() => t.outbound.calls.length === 1);
    const tap = (await avery.post('/api/runs', { playbook: 'test.tap', inputs: { userId: USER } })).json();
    await waitFor(() => t.runs.secrets.heldCount === 1);

    const armed = await armMock(t.app, avery.headers);
    first.open();
    await t.drain();

    const run = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${reads.runId}`,
      headers: armed.headers,
    });
    expect(run.json().run.status).toBe('succeeded');
    expect(t.outbound.calls.filter((c) => c.call.method === 'GET').map((c) => [c.call.path, c.user])).toEqual(
      [
        ['/users/first', AVERY.upn],
        ['/groups/second', AVERY.upn],
      ],
    );
    expect((await avery.get(`/api/runs/${tap.runId}/secret/create`)).statusCode).toBe(401);
    const secret = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${tap.runId}/secret/create`,
      headers: armed.headers,
    });
    expect(secret.json().values).toEqual({ temporaryAccessPass: TAP });
    await t.app.close();
  });

  it('Entra: the Write app redeems into the new id’s partition and the Read partition moves with the session', async () => {
    const auth = new FakeAuthClient();
    const t = await dbApp({ config: entraConfig({ DATABASE_PATH: file }), auth });
    const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
    const state = new URL(login.headers.location as string).searchParams.get('state');
    const signedIn = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: bindingCookie(login)! },
    });
    const cookie = cookieFrom(signedIn)!;
    const csrf = (await getMe(t.app, cookie)).me!.csrf;
    const started = await t.app.inject({
      method: 'POST',
      url: '/auth/arm',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { minutes: 30, reason: 'Disable a test user' },
    });
    const armState = new URL(started.json().redirect).searchParams.get('state');
    const cb = await t.app.inject({
      method: 'GET',
      url: `/auth/arm/callback?code=write-code&state=${armState}`,
      headers: { cookie: `${cookie}; ${bindingCookie(started)}` },
    });
    expect(cb.statusCode).toBe(302);
    const to = hashOf(cookieFrom(cb)!);
    expect(auth.redeems.at(-1)).toMatchObject({ kind: 'write', partitionKey: `write:${to}` });
    expect(rows('select partition_key from token_cache order by partition_key')).toEqual([
      { partition_key: `read:${to}` },
      { partition_key: `write:${to}` },
    ]);
    expect(await t.tokenCache.get(`read:${to}`)).toBe('{"account":"redeemed:good-code"}');
    expect(rows('select id_hash from sessions')).toEqual([{ id_hash: to }]);
    expect((await getMe(t.app, cookie)).res.statusCode).toBe(401);
    expect((await getMe(t.app, cookieFrom(cb)!)).me!.mode).toBe('armed');
    await t.app.close();
  });

  it('Entra: a rotation that fails drops the Write tokens just redeemed, is audited and leaves the session read-only', async () => {
    const auth = new FakeAuthClient();
    const t = await dbApp({ config: entraConfig({ DATABASE_PATH: file }), auth });
    const login = await t.app.inject({ method: 'GET', url: '/auth/login?returnTo=%2F' });
    const state = new URL(login.headers.location as string).searchParams.get('state');
    const signedIn = await t.app.inject({
      method: 'GET',
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: { cookie: bindingCookie(login)! },
    });
    const cookie = cookieFrom(signedIn)!;
    const from = hashOf(cookie);
    const csrf = (await getMe(t.app, cookie)).me!.csrf;
    const started = await t.app.inject({
      method: 'POST',
      url: '/auth/arm',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { minutes: 30, reason: 'Disable a test user' },
    });
    t.sessions.onRotate({
      moveSessionTx: () => {
        throw new Error('database is locked');
      },
    });
    const cb = await t.app.inject({
      method: 'GET',
      url: `/auth/arm/callback?code=write-code&state=${new URL(started.json().redirect).searchParams.get('state')}`,
      headers: { cookie: `${cookie}; ${bindingCookie(started)}`, accept: 'application/json' },
    });
    expect(cb.statusCode).toBe(500);
    expect(cb.json().error).toMatchObject({ code: 'arm_failed', hint: expect.stringContaining('read-only') });
    expect(cookieFrom(cb)).toBeUndefined();
    const redeemed = auth.redeems.at(-1)!.partitionKey;
    expect(auth.forgets).toContainEqual({ kind: 'write', partitionKey: redeemed });
    expect(rows('select partition_key from token_cache')).toEqual([{ partition_key: `read:${from}` }]);
    expect(rows('select id_hash from sessions')).toEqual([{ id_hash: from }]);
    expect((await getMe(t.app, cookie)).me!.mode).toBe('read');
    expect(
      t.audit.rows.filter((r) => r.action === 'session.armed').map((r) => [r.result, r.details]),
    ).toEqual([['failure', expect.objectContaining({ error: 'arm_failed' })]]);
    await t.app.close();
  });
});
