import { isPublicCatalogueValue, tenantValues } from '@adminforge/config';

// The one rule for which local configuration values count as tenant data (@adminforge/config tenant-values.ts): the
// no-tenant-data guard applies it to env files, `adminforge fixtures record` to the loaded env (configKeysOnly).
const TENANT_ID = '9d2f1a77-3b5c-4e8f-9a1b-2c3d4e5f6a7b';

describe('tenant values: the SKU catalogue exemption', () => {
  // The exemption needs both: an AF_LICENCE_SKU_<n> key and a value that looks like a SKU part number. Anything else
  // stored under such a key (a domain, an id, a tenant's own name) is still tenant data.
  it('exempts SKU part numbers under AF_LICENCE_SKU_<n> only', () => {
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_1', 'ENTERPRISEPREMIUM')).toBe(true);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_2', 'SPE_E5')).toBe(true);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_3', 'contoso.onmicrosoft.com')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_4', '00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_5', 'Contoso Special Plan')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_6', 'A')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_7', 'X'.repeat(65))).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_9', 'spe_e5')).toBe(false);
    expect(isPublicCatalogueValue('AF_OTHER_SKU', 'ENTERPRISEPREMIUM')).toBe(false);
    expect(isPublicCatalogueValue('AF_TENANT_ID', 'SPE_E5')).toBe(false);
  });

  it('keeps everything else that looks like tenant data', () => {
    const values = tenantValues({
      AF_LICENCE_SKU_1: 'ENTERPRISEPREMIUM',
      AF_LICENCE_SKU_2: 'contoso.onmicrosoft.com',
      AF_LICENCE_SKU_3: 'Contoso-Custom-Plan',
      AF_LICENCE_SKU_4: 'SPE_E5_NOPSTNCONF',
      AF_PRIMARY_DOMAIN: 'Contoso.example.com',
      AF_TENANT_ID: '00000000-0000-4000-8000-000000000000',
      RUNNER_URL: 'http://127.0.0.1:3101',
      AF_ALLOW_PRIVILEGED_WRITE_SCOPES: 'false',
    });
    expect(values).not.toContain('ENTERPRISEPREMIUM');
    expect(values).not.toContain('SPE_E5_NOPSTNCONF');
    expect(values).toEqual(
      expect.arrayContaining([
        'contoso.onmicrosoft.com',
        'Contoso-Custom-Plan',
        'contoso.example.com',
        '00000000-0000-4000-8000-000000000000',
      ]),
    );
    expect(values).not.toContain('http://127.0.0.1:3101');
    expect(values).not.toContain('false');
  });
});

describe('tenant values: generic values', () => {
  it('allows a bare loopback origin but not a loopback URL with a path or a look-alike host', () => {
    expect(
      tenantValues({
        RUNNER_URL: 'http://127.0.0.1:3101',
        RUNNER_BASE: 'http://127.0.0.1:3101/',
        RUNNER_CALLBACK: `http://127.0.0.1:3101/${TENANT_ID}`,
      }),
    ).toEqual([`http://127.0.0.1:3101/${TENANT_ID}`]);
    expect(tenantValues({ RUNNER_URL: 'http://127.0.0.1.example.net:3101' })).toEqual([
      'http://127.0.0.1.example.net:3101',
    ]);
    expect(tenantValues({ PUBLIC_BASE_URL: 'http://localhost.example.net' })).toEqual([
      'http://localhost.example.net',
    ]);
  });

  it('skips empty, short, boolean and numeric values but keeps a domain lower-cased whatever its length', () => {
    expect(
      tenantValues({
        AF_EMPTY: '',
        AF_UNSET: undefined,
        AF_SHORT: 'abc1234',
        AF_FLAG: 'true',
        AF_COUNT: '123456789',
        AF_PRIMARY_DOMAIN: 'Ex.io',
      }),
    ).toEqual(['ex.io']);
  });
});

describe('tenant values: a loaded environment (configKeysOnly)', () => {
  it('counts only AdminForge configuration keys, not the process environment', () => {
    const env = {
      AF_TENANT_ID: TENANT_ID,
      AF_PRIMARY_DOMAIN: 'Contoso.com',
      API_PORT: '3001',
      AUTH_MODE: 'entra',
      PATH: '/usr/bin:/bin:/x/y/z',
      HOME: '/home/someone-long',
      af_lower_case: 'not-a-config-key',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
    };
    expect(tenantValues(env, { configKeysOnly: true }).sort()).toEqual(
      ['Contoso.com', TENANT_ID, 'contoso.com'].sort(),
    );
    // An env file holds configuration only: every key counts there.
    expect(tenantValues(env)).toEqual(
      expect.arrayContaining(['/usr/bin:/bin:/x/y/z', '/home/someone-long', 'not-a-config-key']),
    );
  });
});
