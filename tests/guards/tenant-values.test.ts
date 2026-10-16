import { isPublicCatalogueValue, tenantValues } from './tenant-values';

// The SKU exemption needs both: an AF_LICENCE_SKU_<n> key and a value that looks like a SKU part number. Anything
// else stored under such a key (a domain, an id, a tenant's own name) is still checked as tenant data.
describe('guard: which local values count as tenant data', () => {
  it('exempts SKU part numbers under AF_LICENCE_SKU_<n> only', () => {
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_1', 'ENTERPRISEPREMIUM')).toBe(true);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_2', 'SPE_E5')).toBe(true);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_3', 'contoso.onmicrosoft.com')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_4', '00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_5', 'Contoso Special Plan')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_6', 'A')).toBe(false);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_7', 'X'.repeat(65))).toBe(false);
    expect(isPublicCatalogueValue('AF_OTHER_SKU', 'ENTERPRISEPREMIUM')).toBe(false);
  });

  it('keeps everything else that looks like tenant data', () => {
    const values = tenantValues({
      AF_LICENCE_SKU_1: 'ENTERPRISEPREMIUM',
      AF_LICENCE_SKU_2: 'contoso.onmicrosoft.com',
      AF_LICENCE_SKU_3: 'Contoso-Custom-Plan',
      AF_PRIMARY_DOMAIN: 'Contoso.example.com',
      AF_TENANT_ID: '00000000-0000-4000-8000-000000000000',
      RUNNER_URL: 'http://127.0.0.1:3101',
      AF_ALLOW_PRIVILEGED_WRITE_SCOPES: 'false',
    });
    expect(values).not.toContain('ENTERPRISEPREMIUM');
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
