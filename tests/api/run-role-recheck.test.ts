import { buildApp } from '@adminforge/api/src/app';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { MemoryPreauthStore } from '@adminforge/api/src/auth/preauth-store';
import { ROLE_FAIL_CLOSED_MS, ROLE_RECHECK_MS } from '@adminforge/api/src/auth/session-plugin';
import { MemorySessionStore, type SessionRecord } from '@adminforge/api/src/auth/session-store';
import { createTokenCache, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { ReauthRequired } from '@adminforge/api/src/auth/types';
import { MemoryPrefsStore } from '@adminforge/api/src/prefs/prefs-store';
import { InProcessRunQueue, MemoryRunRepository } from '@adminforge/api/src/runs';
import type { ServiceCall } from '@adminforge/api/src/execution/types';
import { Clock, entraConfig, FakeAuthClient, noNetwork, TEST_KEY } from './helpers';
import { AVERY, FakeExecutor, sha, StaticDefinitions } from './runs-helpers';

// IAM-03: a run keeps acting as its initiator after the browser is closed. Before each delegated step the worker
// re-confirms the session's roles with Entra (the API's RoleCheck, every ROLE_RECHECK_MS, using the confirmation time
// stored on the session): losing Operator drops write access and parks the next write, and a session Entra refuses
// (or left without a role) ends and parks the run for sign-in — exactly what a browser request would do.
const USER = '00000000-0000-4000-8000-000000000001';
const base = { owner: 'tests', version: '1.0.0' } as const;

function definitions() {
  return new StaticDefinitions().add({
    kind: 'playbook',
    id: 'test.two-writes',
    title: 'Disable and revoke',
    risk: 'low',
    mode: 'write',
    inputs: { userId: { type: 'string', format: 'guid' } },
    steps: [
      {
        id: 'disable',
        type: 'graph',
        mode: 'write',
        describe: 'Disable sign-in',
        request: {
          method: 'PATCH',
          path: '/users/${ $encode(inputs.userId) }',
          body: { accountEnabled: false },
        },
      },
      {
        id: 'revoke',
        type: 'graph',
        mode: 'write',
        describe: 'Revoke sessions',
        request: { method: 'POST', path: '/users/${ $encode(inputs.userId) }/revokeSignInSessions' },
      },
    ],
    ...base,
  } as never);
}

async function setup(respond: (call: ServiceCall, t: { clock: Clock; auth: FakeAuthClient }) => unknown) {
  const clock = new Clock();
  const auth = new FakeAuthClient();
  auth.now = clock.now;
  const sessions = new MemorySessionStore();
  const audit = new MemoryAuditWriter(clock.now);
  const queue = new InProcessRunQueue(undefined, 10);
  const repository = new MemoryRunRepository(clock.now);
  const outbound = new FakeExecutor((call) => respond(call, { clock, auth }));
  const app = await buildApp(entraConfig(), {
    database: null,
    now: clock.now,
    sessions,
    preauth: new MemoryPreauthStore(),
    audit,
    prefs: new MemoryPrefsStore(),
    tokenCache: createTokenCache(new MemorySealedBlobStore(), Buffer.from(TEST_KEY, 'base64')),
    fetch: noNetwork,
    auth,
    runs: { definitions: definitions(), outbound, queue, repository, sweep: false },
  });
  await app.ready();

  // An armed Reader + Operator, signed in (roles confirmed) just now.
  const sid = 'sid-role-recheck';
  const now = clock.now();
  const record: SessionRecord = {
    idHash: sha(sid),
    userOid: AVERY.oid,
    upn: AVERY.upn,
    displayName: AVERY.upn,
    tenantId: '00000000-0000-4000-8000-00000000e0e0',
    tenantName: 'Example Org',
    tenantDomain: 'example.com',
    roles: ['Portal.Reader', 'Portal.Operator'],
    csrf: 'csrf-1',
    readAccountId: 'read-account',
    writeAccountId: 'write-account',
    writeExpiresAt: new Date(now.getTime() + 60 * 60_000),
    writeExtended: false,
    writeReason: 'tests',
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 12 * 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'vitest',
    rolesCheckedAt: now,
  };
  await sessions.create(record);
  const headers = { cookie: `adminforge-dev=${sid}`, 'x-adminforge-csrf': record.csrf };

  const start = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers,
      payload: { playbook: 'test.two-writes', inputs: { userId: USER } },
    });
    expect(res.statusCode).toBe(202);
    await queue.drain();
    return (await repository.getRun(res.json().runId))!;
  };
  return { app, clock, auth, sessions, audit, outbound, record, headers, start };
}

describe('the run worker keeps a session’s roles current (IAM-03)', () => {
  it('Operator removed while the run is going: the next write parks awaiting_arm and write access ends', async () => {
    const t = await setup((call, { clock, auth }) => {
      if (call.method === 'PATCH') {
        // The browser is closed; meanwhile the person is removed from the Operator group.
        clock.advance(ROLE_RECHECK_MS + 1000);
        auth.refreshImpl = async () => ({ roles: ['Portal.Reader'], acct: 0 });
      }
      return null;
    });
    const run = await t.start();
    expect(run.status).toBe('awaiting_arm');
    expect(t.outbound.calls.map((c) => [c.call.method, c.mode])).toEqual([['PATCH', 'write']]);
    expect(t.auth.refreshes).toEqual([{ kind: 'read', partitionKey: `read:${t.record.idHash}` }]);

    const row = (await t.sessions.get(t.record.idHash))!;
    expect(row.roles).toEqual(['Portal.Reader']);
    expect(row.writeAccountId).toBeNull();
    expect(row.writeExpiresAt).toBeNull();
    expect(row.rolesCheckedAt).toEqual(t.clock.now());
    expect(t.auth.forgets).toContainEqual({ kind: 'write', partitionKey: `write:${t.record.idHash}` });
    expect(t.audit.rows.find((r) => r.action === 'session.roles_changed')).toMatchObject({
      actorOid: AVERY.oid,
      sessionHash: t.record.idHash,
      correlationId: run.correlationId,
      details: {
        previousRoles: ['Portal.Reader', 'Portal.Operator'],
        roles: ['Portal.Reader'],
        runId: run.id,
      },
    });
    await t.app.close();
  });

  it('Entra refuses the refresh (account disabled): the session ends and the run parks awaiting_reauth', async () => {
    const t = await setup((call, { clock, auth }) => {
      if (call.method === 'PATCH') {
        clock.advance(ROLE_RECHECK_MS + 1000);
        auth.refreshImpl = async () => {
          throw new ReauthRequired('read');
        };
      }
      return null;
    });
    const run = await t.start();
    expect(run.status).toBe('awaiting_reauth');
    expect(t.outbound.calls).toHaveLength(1);
    expect(await t.sessions.get(t.record.idHash)).toBeNull();
    expect(t.audit.rows.find((r) => r.action === 'session.access_revoked')).toMatchObject({
      details: { reason: 'reauth', runId: run.id },
    });
    await t.app.close();
  });

  it('no AdminForge role left: the session ends (audited) and the run parks awaiting_reauth', async () => {
    const t = await setup((call, { clock, auth }) => {
      if (call.method === 'PATCH') {
        clock.advance(ROLE_RECHECK_MS + 1000);
        auth.refreshImpl = async () => ({ roles: [], acct: 0 });
      }
      return null;
    });
    expect((await t.start()).status).toBe('awaiting_reauth');
    expect(t.audit.rows.find((r) => r.action === 'session.access_revoked')).toMatchObject({
      details: { reason: 'roles', previousRoles: ['Portal.Reader', 'Portal.Operator'] },
    });
    await t.app.close();
  });

  it('within the interval nothing is refreshed and the run finishes', async () => {
    const t = await setup((call, { clock }) => {
      if (call.method === 'PATCH') clock.advance(ROLE_RECHECK_MS - 1000);
      return null;
    });
    expect((await t.start()).status).toBe('succeeded');
    expect(t.auth.refreshes).toHaveLength(0);
    expect(t.outbound.calls).toHaveLength(2);
    await t.app.close();
  });

  it('unchanged roles: the confirmation is stored, so the browser’s next request doesn’t refresh again', async () => {
    const t = await setup((call, { clock }) => {
      if (call.method === 'PATCH') clock.advance(ROLE_RECHECK_MS + 1000);
      return null;
    });
    expect((await t.start()).status).toBe('succeeded');
    expect(t.auth.refreshes).toHaveLength(1);
    expect((await t.sessions.get(t.record.idHash))!.rolesCheckedAt).toEqual(t.clock.now());
    expect(t.audit.rows.some((r) => r.action.startsWith('session.'))).toBe(false);
    // The API reads the same stored confirmation.
    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.headers });
    expect(me.statusCode).toBe(200);
    expect(t.auth.refreshes).toHaveLength(1);
    await t.app.close();
  });

  it('a transient Entra failure keeps the run going, until the roles have been unconfirmed for too long', async () => {
    let calls = 0;
    const t = await setup((call, { clock, auth }) => {
      if (call.method === 'PATCH') {
        clock.advance(ROLE_RECHECK_MS + 1000);
        auth.refreshImpl = async () => {
          calls++;
          throw new Error('ETIMEDOUT');
        };
      }
      return null;
    });
    expect((await t.start()).status).toBe('succeeded');
    expect(calls).toBe(1);
    expect(await t.sessions.get(t.record.idHash)).not.toBeNull();

    // Still failing past ROLE_FAIL_CLOSED_MS since the last confirmation: the next delegated use ends the session.
    t.clock.advance(ROLE_FAIL_CLOSED_MS);
    await t.sessions.update(t.record.idHash, { lastSeenAt: t.clock.now() });
    expect(await t.app.runs.identity.liveSession(t.record.idHash, { runId: 'run-later' })).toBeNull();
    expect(await t.sessions.get(t.record.idHash)).toBeNull();
    expect(t.audit.rows.find((r) => r.action === 'session.access_revoked')).toMatchObject({
      details: { reason: 'unconfirmed', runId: 'run-later' },
    });
    await t.app.close();
  });
});
