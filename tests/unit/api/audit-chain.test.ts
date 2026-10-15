import { canonical, chainHash, GENESIS, verifyChain } from '@adminforge/api/src/audit/chain';
import { MemoryAuditWriter, toAuditEvent } from '@adminforge/api/src/audit/writer';

const ev = (action: string) => ({
  ts: '2026-10-15T12:00:00.000Z',
  actorOid: 'u1',
  action,
  result: 'success',
  correlationId: 'c',
  details: { b: 2, a: 1 } as Record<string, number>,
});

describe('audit chain', () => {
  it('canonicalises with sorted keys and no undefined', () => {
    expect(canonical({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
    expect(canonical({ x: null, d: new Date('2026-10-15T00:00:00.000Z') })).toBe(
      '{"d":"2026-10-15T00:00:00.000Z","x":null}',
    );
  });

  it('verifies an intact chain and finds the first tampered row', () => {
    const rows: Array<ReturnType<typeof ev> & { prevHash: string; hash: string }> = [];
    let prev = GENESIS;
    for (const a of ['session.signin', 'session.armed', 'run.started']) {
      const hash = chainHash(prev, ev(a));
      rows.push({ ...ev(a), prevHash: prev, hash });
      prev = hash;
    }
    expect(verifyChain(rows)).toEqual({ ok: true });
    rows[1]!.details = { a: 1, b: 3 };
    expect(verifyChain(rows)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('detects a removed row', () => {
    let prev = GENESIS;
    const rows = ['a', 'b', 'c'].map((a) => {
      const hash = chainHash(prev, ev(a));
      const row = { ...ev(a), prevHash: prev, hash };
      prev = hash;
      return row;
    });
    expect(verifyChain([rows[0]!, rows[2]!])).toEqual({ ok: false, brokenAt: 1 });
  });

  it('hashes every column, with nulls for absent ones, so persisted rows re-verify', () => {
    const event = toAuditEvent(
      { action: 'x', result: 'success', correlationId: 'c', details: { keep: 1, drop: undefined } },
      new Date('2026-10-15T12:00:00.000Z'),
    );
    expect(event).toEqual({
      ts: '2026-10-15T12:00:00.000Z',
      actorOid: null,
      actorUpn: null,
      sessionHash: null,
      mode: null,
      action: 'x',
      targetType: null,
      targetId: null,
      details: { keep: 1 },
      result: 'success',
      correlationId: 'c',
      ip: null,
    });
  });

  it('MemoryAuditWriter appends a verifiable chain and notices tampering', async () => {
    const writer = new MemoryAuditWriter(() => new Date('2026-10-15T12:00:00.000Z'));
    const first = await writer.append({
      action: 'session.signin',
      result: 'success',
      correlationId: 'c1',
      actorOid: 'u1',
    });
    const second = await writer.append({
      action: 'session.armed',
      result: 'success',
      correlationId: 'c2',
      details: { minutes: 30 },
    });
    expect(first.prevHash).toBe(GENESIS);
    expect(second.prevHash).toBe(first.hash);
    expect(await writer.verify()).toEqual({ ok: true, count: 2 });
    writer.rows[0]!.actorOid = 'someone-else';
    expect(await writer.verify()).toEqual({ ok: false, brokenAt: 0, seq: 1 });
  });
});
