import { vaultCredentials } from '@adminforge/api/src/probes/platform-checks';
import type { VaultStatus } from '@adminforge/api/src/auth/vault';

// The "Credentials from Vault" platform probe (ADR-018): ok when every identity's credential was read, warn when a read
// failed but the last good credential stays or nothing was read yet, crit when an identity has no usable credential;
// ok and quiet where Vault isn't used. Messages name identities only — the Vault path and status are in the details,
// which only Operators see.
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
        lastRefreshAt: at,
        identities: { automation: 'loaded', 'reports-team': 'loaded' },
        errors: {},
      }),
    ).toMatchObject({ status: 'ok', metric: 2 });
  });

  it('is critical when an identity has no usable credential, naming it', async () => {
    for (const state of ['missing', 'unavailable'] as const) {
      const r = await check({
        lastRefreshAt: at,
        identities: { automation: 'loaded', 'reports-team': state },
        errors:
          state === 'unavailable'
            ? { 'reports-team': 'Vault refused to read secret/data/x (HTTP 403).' }
            : {},
      });
      expect(r).toMatchObject({ status: 'crit', code: 'credential_unavailable', metric: 1 });
      expect(r.message).toContain('reports-team');
      expect(r.message).not.toMatch(/secret\/data|HTTP|AF_/);
    }
  });

  it('warns when a read failed but the credential read earlier stays, with the path for Operators only', async () => {
    const error =
      'Vault at AF_VAULT_ADDR could not be reached (GET /v1/secret/data/adminforge/dev/identities/automation).';
    const r = await check({
      lastRefreshAt: at,
      identities: { automation: 'stale' },
      errors: { automation: error },
    });
    expect(r).toMatchObject({
      status: 'warn',
      code: 'vault_unreachable',
      message: expect.stringContaining('read earlier stay in use'),
      details: { rows: [{ identity: 'automation', state: 'stale', problem: error }] },
    });
    expect(r.message).not.toMatch(/secret\/data|AF_VAULT/);
  });

  it('warns before the first read', async () => {
    expect(
      await check({ lastRefreshAt: null, identities: { automation: 'not_read' }, errors: {} }),
    ).toMatchObject({
      status: 'warn',
      code: 'vault_not_read',
    });
  });
});
