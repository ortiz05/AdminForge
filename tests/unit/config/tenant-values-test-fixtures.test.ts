import { ADMIN_ENV_KEYS, TEST_FIXTURE_NAMES, tenantValues } from '@adminforge/config';
import { FIXTURE_NAMES } from '@adminforge/cli/src/provision/fixtures-model';

// The licensed test fixtures' keys (portal/packages/config): admin-only, and their values — a Microsoft SKU part
// number and a list of fixture names — are not tenant data (the docs show them), unless they don't look like that.

describe('licensed test fixture keys', () => {
  it('live in the admin file only', () => {
    for (const key of [
      'AF_TEST_LICENCE_SKU',
      'AF_TEST_FIXTURES',
      'AF_TEST_APPROVER_UPN',
      'AF_TEST_APPROVER_PASSWORD',
      'AF_TEST_APPROVER_TOTP_SECRET',
    ])
      expect(ADMIN_ENV_KEYS).toContain(key);
  });

  it('a SKU part number and a list of fixture names are not tenant data', () => {
    expect(
      tenantValues({
        AF_TEST_LICENCE_SKU: 'ENTERPRISEPREMIUM',
        AF_TEST_FIXTURES: 'pim,named-location,intune,approver',
      }),
    ).toEqual([]);
  });

  it('anything else under those keys still is — a fixture list means the literal fixture names only', () => {
    expect(tenantValues({ AF_TEST_LICENCE_SKU: 'contoso-internal-sku' })).toEqual(['contoso-internal-sku']);
    expect(tenantValues({ AF_TEST_FIXTURES: 'pim,contoso.example.com' })).toEqual([
      'pim,contoso.example.com',
    ]);
    expect(tenantValues({ AF_TEST_FIXTURES: 'pim,contoso-finance' })).toEqual(['pim,contoso-finance']);
    expect(tenantValues({ AF_TEST_FIXTURES: 'Intune, PIM' })).toEqual([]);
  });

  it('the CLI uses the same fixture names', () => {
    expect([...FIXTURE_NAMES]).toEqual([...TEST_FIXTURE_NAMES]);
  });

  it('the approver password counts', () => {
    expect(tenantValues({ AF_TEST_APPROVER_PASSWORD: 'Synthetic-Password-123' })).toEqual([
      'Synthetic-Password-123',
    ]);
  });
});
