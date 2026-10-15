import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { Probe } from '@adminforge/schemas';

// graphCount: alert on how many items a Graph list holds — too many (new high-severity alerts) or too few
// (fewer than two Global Administrators) — as the automation identity, following pages.
const NOW = new Date('2026-10-15T12:00:00.000Z');

const probe = (check: Record<string, unknown>, thresholds?: Record<string, number>) =>
  Probe.parse({
    kind: 'probe',
    id: 'probes.count',
    version: '1.0.0',
    title: 'Count',
    owner: 'test',
    check: { kind: 'graphCount', path: '/directoryRoles/roleTemplateId=x/members', ...check },
    ...(thresholds ? { thresholds } : {}),
  });

function deps(value: unknown[]) {
  const calls: Array<Record<string, unknown>> = [];
  const outbound = {
    execute: async (identity: unknown, call: Record<string, unknown>) => {
      calls.push({ identity, ...call });
      return { status: 200, data: { value } };
    },
  } as unknown as OutboundExecutor;
  const d: ProbeDeps = {
    outbound,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => ({}),
    now: () => NOW,
    fetch: async () => new Response('{}'),
  };
  return { d, calls };
}

const admins = [
  { id: 'u1', displayName: 'Avery Lee', userType: 'Member' },
  { id: 'u2', displayName: 'Partner', userType: 'Guest' },
];

describe('graphCount probes', () => {
  it('counts every item by default, reads all pages as the automation identity, keeps id and name', async () => {
    const { d, calls } = deps(admins);
    const out = await runProbe('probes.count', probe({}), d);
    expect(calls[0]).toMatchObject({
      identity: { kind: 'automation' },
      method: 'GET',
      paging: 'all',
      maxItems: 1000,
    });
    expect(out).toMatchObject({ metric: 2, unit: 'items', status: 'warn' }); // default: warn at 1 or more
    expect(out.details?.rows).toEqual([
      { id: 'u1', displayName: 'Avery Lee' },
      { id: 'u2', displayName: 'Partner' },
    ]);
  });

  it('counts only what the items expression selects', async () => {
    const { d } = deps(admins);
    const out = await runProbe(
      'probes.count',
      probe({ items: "${ value[userType = 'Guest'] }", fields: ['displayName', 'userType'] }, { crit: 1 }),
      d,
    );
    expect(out).toMatchObject({ metric: 1, status: 'crit' });
    expect(out.details?.rows).toEqual([{ displayName: 'Partner', userType: 'Guest' }]);
  });

  it('with worse: lower, too few items is the problem ("at least two Global Administrators")', async () => {
    const one = await runProbe(
      'probes.count',
      probe({ worse: 'lower' }, { crit: 1 }),
      deps(admins.slice(0, 1)).d,
    );
    expect(one).toMatchObject({ metric: 1, status: 'crit' });
    const two = await runProbe('probes.count', probe({ worse: 'lower' }, { crit: 1 }), deps(admins).d);
    expect(two).toMatchObject({ metric: 2, status: 'ok' });
  });

  it('refuses worse: lower without thresholds, and thresholds in the wrong order', () => {
    expect(() => probe({ worse: 'lower' })).toThrow(/set thresholds/);
    expect(() => probe({ worse: 'lower' }, { warn: 1, crit: 3 })).toThrow(/warn must be ≥ crit/);
    expect(() => probe({}, { warn: 5, crit: 2 })).toThrow(/warn must be ≤ crit/);
  });
});
