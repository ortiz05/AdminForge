import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { Probe } from '@adminforge/schemas';

// A probe whose path names a setting the installation doesn't have (probes.arm-subscription-access while
// AF_SUBSCRIPTION_ID is unset) reports "not configured", naming the setting, and calls nothing.
const NOW = new Date('2026-10-17T12:00:00.000Z');

const probe = (check: Record<string, unknown>) =>
  Probe.parse({ kind: 'probe', id: 'probes.sub', version: '1.0.0', title: 'Sub', owner: 'test', check });

function deps(env: Record<string, string | undefined>) {
  const calls: unknown[] = [];
  const outbound = {
    execute: async (_identity: unknown, call: unknown) => {
      calls.push(call);
      return { status: 200, data: { value: [{ id: 'x' }] } };
    },
  } as unknown as OutboundExecutor;
  const d: ProbeDeps = {
    outbound,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => env,
    now: () => NOW,
    fetch: async () => new Response('{}'),
  };
  return { d, calls };
}

const arm = {
  kind: 'arm',
  path: '/subscriptions/${ $encode(env.AF_SUBSCRIPTION_ID) }/resourcegroups',
  apiVersion: '2021-04-01',
  expect: { status: 200 },
};

describe('probes on a setting that is not set', () => {
  it.each([undefined, '', '   '])('AF_SUBSCRIPTION_ID=%j: not configured, nothing called', async (value) => {
    const { d, calls } = deps({ AF_SUBSCRIPTION_ID: value });
    const out = await runProbe('probes.sub', probe(arm), d);
    expect(out).toMatchObject({ status: 'error', code: 'not_configured' });
    expect(out.message).toMatch(/AF_SUBSCRIPTION_ID is not set, so this check has nothing to look at/);
    expect(calls).toEqual([]);
  });

  it('runs as before once the setting is there', async () => {
    const { d, calls } = deps({ AF_SUBSCRIPTION_ID: '00000000-0000-4000-8000-000000000001' });
    const out = await runProbe('probes.sub', probe(arm), d);
    expect(out.status).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('graphCount checks too', async () => {
    const { d, calls } = deps({});
    const out = await runProbe(
      'probes.sub',
      probe({ kind: 'graphCount', path: '/groups/${ $encode(env.AF_SOME_GROUP_ID) }/members' }),
      d,
    );
    expect(out).toMatchObject({ status: 'error', code: 'not_configured' });
    expect(calls).toEqual([]);
  });
});
