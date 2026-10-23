import { vaultCredentials } from '@adminforge/api/src/probes/platform-checks';
import type { VaultStatus } from '@adminforge/api/src/auth/vault';

// The "Credentials from Vault" platform probe (ADR-018): ok when every identity's credential was read, warn when the
// last read failed (the last good credentials stay) or none happened yet, crit when an identity has nothing at its path;
// ok and quiet where Vault isn't used.
const check = (status: VaultStatus | null | undefined) =>
  vaultCredentials({ kind: 'vaultCredentials' }, {
    deps: status === undefined ? {} : { vault: () => status },
  } as never);
const at = '2026-10-23T12:00:00.000Z';

describe('vaultCredentials check', () => {
  it('is ok where Vault isn’t used', async () => {
    expect(await check(undefined)).toMatchObject({
      status: 'ok',
      message: expect.stringMatching(/isn’t used here/),
    });
  });

  it('is ok with every credential read', async () => {
    expect(
      await check({
        reachable: true,
        lastRefreshAt: at,
        identities: { automation: 'loaded', 'reports-team': 'loaded' },
      }),
    ).toMatchObject({
      status: 'ok',
      metric: 2,
    });
  });

  it('is critical when an identity has no credential, naming it', async () => {
    const r = await check({
      reachable: true,
      lastRefreshAt: at,
      identities: { automation: 'loaded', 'reports-team': 'missing' },
    });
    expect(r).toMatchObject({ status: 'crit', code: 'credential_unavailable', metric: 1 });
    expect(r.message).toContain('reports-team');
  });

  it('warns when Vault couldn’t be read, or hasn’t been yet', async () => {
    expect(
      await check({
        reachable: false,
        lastRefreshAt: at,
        identities: { automation: 'loaded' },
        error:
          'Vault at AF_VAULT_ADDR could not be reached (GET /v1/secret/data/adminforge/dev/identities/automation).',
      }),
    ).toMatchObject({
      status: 'warn',
      code: 'vault_unreachable',
      message: expect.stringContaining('last good credentials'),
    });
    expect(
      await check({ reachable: false, lastRefreshAt: null, identities: { automation: 'not_read' } }),
    ).toMatchObject({
      status: 'warn',
      code: 'vault_not_read',
    });
  });
});
