import { randomBytes } from 'node:crypto';
import { chainKeysFrom } from '@adminforge/api/src/audit/keys';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { probe } from './helpers';

// probes.audit-chain on a keyed chain (S-10): it verifies with the configured keys, and when a keyed part's key isn't
// configured it says that — not "an event was changed" — with the configuration key to fix it and no key value.
const NOW = new Date('2026-10-21T09:00:00Z');
const deps = (audit: ProbeDeps['audit']) =>
  ({
    outbound: {} as ProbeDeps['outbound'],
    automation: null,
    connection: async () => {
      throw new Error('unused');
    },
    env: () => ({}),
    now: () => NOW,
    fetch: async () => new Response(''),
    audit,
  }) as ProbeDeps;
const chainProbe = probe('probes.audit-chain', { check: { kind: 'auditChain' } });
const event = (i: number) => ({
  actorOid: 'a',
  actorUpn: 'a@example.com',
  mode: 'read' as const,
  action: 'test',
  correlationId: `c${i}`,
  result: 'success' as const,
});

describe('auditChain probe on a keyed chain', () => {
  it('is ok across the cut-over with the key, and names the missing key (by id) without it', async () => {
    const key = randomBytes(32).toString('base64');
    const ring = chainKeysFrom({ AUDIT_CHAIN_KEY: key })!;
    const keyed = new MemoryAuditWriter(() => NOW, ring);
    await keyed.append(event(1));
    keyed.prepareChain();
    await keyed.append(event(2));
    expect(await runProbe('probes.audit-chain', chainProbe, deps(keyed))).toMatchObject({
      status: 'ok',
      metric: 3,
    });

    const unkeyed = new MemoryAuditWriter(() => NOW);
    unkeyed.rows.push(...structuredClone(keyed.rows));
    const o = await runProbe('probes.audit-chain', chainProbe, deps(unkeyed));
    expect(o).toMatchObject({ status: 'crit', code: 'audit_chain_key_missing', metric: 1 });
    expect(o.message).toMatch(/can't be verified from event #1 \(seq 2\).*AUDIT_CHAIN_PREVIOUS_KEYS/);
    expect(o.message).toContain(ring.current.id);
    expect(o.message).not.toContain(key);
  });
});
