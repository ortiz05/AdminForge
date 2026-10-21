import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { MemoryRunRepository } from '@adminforge/api/src/runs';
import { SecretBroker, type SecretMessage, type SecretStream } from '@adminforge/api/src/runs/secrets';

// S-08: a show-once secret follows its session when the session's id is rotated (arming) — including one produced
// while the rotation commits — and never reaches a stream opened with the old id.

const NOW = new Date('2026-10-15T12:00:00.000Z');

const secretFor = (sessionHash: string) =>
  ({
    runId: 'run-1',
    rootRunId: 'run-1',
    stepId: 'create',
    stepPath: 'create',
    values: { temporaryAccessPass: 'Tap-Value' },
    hints: { temporaryAccessPass: '…alue' },
    sessionHash,
    initiatorOid: '00000000-0000-4000-8000-0000000000a1',
    initiatorUpn: 'avery@example.com',
    correlationId: 'c-1',
    producedAt: NOW.toISOString(),
  }) as Parameters<SecretBroker['handoff']>[0];

function broker(sessionLive: (b: SecretBroker) => Promise<boolean> = async () => true) {
  const b: SecretBroker = new SecretBroker({
    repo: new MemoryRunRepository(() => NOW),
    audit: new MemoryAuditWriter(() => NOW),
    sessionLive: () => sessionLive(b),
  });
  return b;
}

function stream(sessionHash: string) {
  const sent: SecretMessage[] = [];
  const state = { closed: 0 };
  const s: SecretStream = {
    runId: 'run-1',
    sessionHash,
    send: (m) => sent.push(m),
    close: () => state.closed++,
  };
  return { s, sent, state };
}

describe('show-once secrets across a session id rotation', () => {
  it('rotated while it was being delivered: held for the new id, never written to the old id’s stream', async () => {
    const b = broker(async (self) => {
      self.sessionMoved({ from: 'old', to: 'new', gainsWrite: true });
      return true;
    });
    const old = stream('old');
    b.attach(old.s);
    expect(await b.handoff(secretFor('old'))).toBe('held');
    expect(old.sent).toEqual([]);
    expect(old.state.closed).toBe(1);
    expect(await b.claim('run-1', 'create', 'old')).toBeNull();
    expect((await b.claim('run-1', 'create', 'new'))?.values).toEqual({ temporaryAccessPass: 'Tap-Value' });
    await b.stop();
  });

  it('produced for an id rotated just before: it goes to the new id’s stream', async () => {
    const b = broker();
    b.sessionMoved({ from: 'old', to: 'mid', gainsWrite: true });
    b.sessionMoved({ from: 'mid', to: 'new', gainsWrite: false });
    const now = stream('new');
    b.attach(now.s);
    expect(await b.handoff(secretFor('old'))).toBe('delivered');
    expect(now.sent.map((m) => m.values)).toEqual([{ temporaryAccessPass: 'Tap-Value' }]);
    await b.stop();
  });

  it('a held secret moves with the session; a stream that attaches with the old id ends at once', async () => {
    const b = broker();
    expect(await b.handoff(secretFor('old'))).toBe('held');
    b.sessionMoved({ from: 'old', to: 'new', gainsWrite: true });
    const late = stream('old');
    b.attach(late.s);
    expect(late.state.closed).toBe(1);
    const current = stream('new');
    b.attach(current.s);
    expect(current.state.closed).toBe(0);
    expect(await b.claim('run-1', 'create', 'old')).toBeNull();
    expect(await b.claim('run-1', 'create', 'new')).not.toBeNull();
    await b.stop();
  });
});
