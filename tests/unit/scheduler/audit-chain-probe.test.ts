import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { probe } from './helpers';

// probes.audit-chain: the scheduler re-walks the audit hash chain hourly and the monitoring page shows the result.
const NOW = new Date('2026-10-15T12:00:00Z');
const deps = (audit?: ProbeDeps['audit']) =>
  ({
    outbound: {} as ProbeDeps['outbound'],
    automation: null,
    connection: async () => {
      throw new Error('unused');
    },
    env: () => ({}),
    now: () => NOW,
    fetch: async () => new Response(''),
    ...(audit ? { audit } : {}),
  }) as ProbeDeps;
const chainProbe = probe('probes.audit-chain', { check: { kind: 'auditChain' } });

describe('auditChain probe', () => {
  it('is ok with the number of verified events', async () => {
    const audit = new MemoryAuditWriter(() => NOW);
    for (let i = 0; i < 3; i++)
      await audit.append({
        actorOid: 'a',
        actorUpn: 'a@example.com',
        mode: 'read',
        action: 'test',
        correlationId: `c${i}`,
        result: 'success',
      });
    expect(await runProbe('probes.audit-chain', chainProbe, deps(audit))).toMatchObject({
      status: 'ok',
      metric: 3,
    });
  });

  it('is critical when the chain is broken, with what to do next', async () => {
    const broken = { verify: async () => ({ ok: false as const, brokenAt: 7, seq: 42 }) };
    const o = await runProbe('probes.audit-chain', chainProbe, deps(broken));
    expect(o).toMatchObject({ status: 'crit', code: 'audit_chain_broken' });
    expect(o.message).toMatch(/adminforge audit verify/);
  });

  it('reports not configured without an audit log', async () => {
    expect(await runProbe('probes.audit-chain', chainProbe, deps())).toMatchObject({
      status: 'error',
      code: 'not_configured',
    });
  });
});
