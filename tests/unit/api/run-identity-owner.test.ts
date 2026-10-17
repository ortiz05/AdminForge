import { MemorySessionStore, type SessionRecord } from '@adminforge/api/src/auth/session-store';
import { SessionIdentityResolver } from '@adminforge/api/src/runs/identity';
import { MemoryRunRepository } from '@adminforge/api/src/runs/memory-repository';

// A session hash recorded for a person — as a run's initiator or on their approval decision — only ever acts as that
// person (runs/identity.ts `liveSession(…, expectOid)`): a row pointing at someone else's session is refused, whatever
// it says. The database refuses rebinding a decision to another person's session too (migration 0011).
const NOW = new Date('2026-10-17T12:00:00Z');

const session = (idHash: string, userOid: string): SessionRecord => ({
  idHash,
  userOid,
  upn: `${userOid}@example.com`,
  displayName: userOid,
  tenantId: 't',
  tenantName: 'Example Org',
  tenantDomain: 'example.com',
  roles: ['Portal.Reader', 'Portal.Operator'],
  csrf: 'c',
  readAccountId: null,
  writeAccountId: null,
  writeExpiresAt: null,
  writeExtended: false,
  writeReason: null,
  createdAt: NOW,
  lastSeenAt: NOW,
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  ip: null,
  userAgent: null,
});

describe('run identity: a recorded session acts only as its own person', () => {
  it('uses a session of the expected person and refuses one of someone else', async () => {
    const sessions = new MemorySessionStore();
    await sessions.create(session('s-avery', 'avery'));
    await sessions.create(session('s-mallory', 'mallory'));
    const warned: string[] = [];
    const identity = new SessionIdentityResolver(
      new MemoryRunRepository(),
      sessions,
      { SESSION_IDLE_MINUTES: 60 },
      () => NOW,
      { log: { warn: (_o, msg) => void warned.push(msg) } },
    );
    expect((await identity.liveSession('s-avery', {}, 'avery'))?.userOid).toBe('avery');
    expect(await identity.liveSession('s-mallory', { runId: 'r1' }, 'avery')).toBeNull();
    expect(warned).toEqual([expect.stringMatching(/session of another person/)]);
    // Without an expected person (callers that only need a live session) the check is not applied.
    expect((await identity.liveSession('s-mallory'))?.userOid).toBe('mallory');
  });
});
