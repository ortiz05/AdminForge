import { auditVerify, type AuditChain } from '@adminforge/cli/src/commands/audit';
import { ConfigError } from '@adminforge/cli/src/shared/errors';

// `adminforge audit verify`: re-walks the hash chain (the API's PgAuditWriter) and prints one verdict line.
describe('adminforge audit verify', () => {
  const DB = 'postgres://example@db.example.com:5432/adminforge';

  function chain(result: Awaited<ReturnType<AuditChain['verify']>> | Error) {
    const calls = { opened: [] as string[], closed: 0 };
    const open = (url: string): AuditChain => {
      calls.opened.push(url);
      return {
        verify: async () => {
          if (result instanceof Error) throw result;
          return result;
        },
        close: async () => {
          calls.closed++;
        },
      };
    };
    return { open, calls };
  }

  it('reports an intact chain and closes the connection', async () => {
    const lines: string[] = [];
    const c = chain({ ok: true, count: 42 });
    expect(await auditVerify({ DATABASE_URL: DB }, (l) => lines.push(l), c.open)).toBe(true);
    expect(lines).toEqual(['✓ Audit chain verified: 42 event(s), every hash links to the one before it.']);
    expect(c.calls).toEqual({ opened: [DB], closed: 1 });
  });

  it('reports where the chain breaks, and what to do', async () => {
    const lines: string[] = [];
    const c = chain({ ok: false, brokenAt: 7, seq: 1007 });
    expect(await auditVerify({ DATABASE_URL: DB }, (l) => lines.push(l), c.open)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^✗ Audit chain broken at event #7 \(seq 1007\): .*Restore from a backup/);
    expect(c.calls.closed).toBe(1);
  });

  it('closes the connection when the walk fails', async () => {
    const c = chain(new Error('connection lost'));
    await expect(auditVerify({ DATABASE_URL: DB }, () => undefined, c.open)).rejects.toThrow(
      'connection lost',
    );
    expect(c.calls.closed).toBe(1);
  });

  it('needs DATABASE_URL, and opens nothing without it', async () => {
    const c = chain({ ok: true, count: 0 });
    await expect(auditVerify({}, () => undefined, c.open)).rejects.toThrow(ConfigError);
    await expect(auditVerify({}, () => undefined, c.open)).rejects.toThrow(/DATABASE_URL is not set/);
    expect(c.calls.opened).toEqual([]);
  });
});
