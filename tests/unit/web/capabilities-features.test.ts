import { capabilitiesQuery } from '@adminforge/web/src/playbooks/contracts';

// The playbook preflight checks `requires.licences` by feature key (pim, signInLogs…), not only SKU part numbers.
afterEach(() => vi.unstubAllGlobals());

describe('capabilities contract: licence features', () => {
  it('parses features with availability and labels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              roles: { active: [], eligible: [] },
              skus: ['AAD_PREMIUM'],
              features: {
                pim: { available: false, label: 'Microsoft Entra ID P2' },
                signInLogs: { enabled: true, label: 'Sign-in logs (Entra ID P1)' },
                unknown: { label: 'Unreadable' },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const caps = await capabilitiesQuery.queryFn!({ signal: new AbortController().signal } as never);
    expect(caps.features).toEqual({
      pim: { available: false, label: 'Microsoft Entra ID P2' },
      signInLogs: { available: true, label: 'Sign-in logs (Entra ID P1)' },
      unknown: { available: null, label: 'Unreadable' },
    });
    expect(caps.skus).toEqual(['AAD_PREMIUM']);
  });
});
