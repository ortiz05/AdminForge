import { forbiddenValues, isPublicCatalogueValue } from '@adminforge/cli/src/commands/content';

// Licence SKU part numbers are Microsoft's catalogue names, not tenant data: they may appear in committed content —
// but only values under AF_LICENCE_SKU_<n> that look like a SKU part number (^[A-Z0-9_]{2,64}$).
describe('forbiddenValues', () => {
  it('ignores AF_LICENCE_SKU_* values and keeps tenant values', () => {
    const out = forbiddenValues({
      AF_LICENCE_SKU_1: 'ENTERPRISEPREMIUM',
      AF_LICENCE_SKU_2: 'SPE_E5_NOPSTNCONF',
      AF_PRIMARY_DOMAIN: 'contoso.example.com',
      AF_TENANT_ID: '00000000-0000-4000-8000-000000000000',
    });
    expect(out).not.toContain('ENTERPRISEPREMIUM');
    expect(out).not.toContain('SPE_E5_NOPSTNCONF');
    expect(out).toContain('contoso.example.com');
    expect(out).toContain('00000000-0000-4000-8000-000000000000');
  });

  it('still treats a value under AF_LICENCE_SKU_<n> that is not a SKU part number as tenant data', () => {
    const out = forbiddenValues({
      AF_LICENCE_SKU_1: 'contoso.onmicrosoft.com',
      AF_LICENCE_SKU_2: '00000000-0000-4000-8000-000000000001',
      AF_LICENCE_SKU_3: 'Contoso Enterprise Plan',
    });
    expect(out).toEqual(
      expect.arrayContaining([
        'contoso.onmicrosoft.com',
        '00000000-0000-4000-8000-000000000001',
        'Contoso Enterprise Plan',
      ]),
    );
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_9', 'SPE_E5')).toBe(true);
    expect(isPublicCatalogueValue('AF_LICENCE_SKU_9', 'spe_e5')).toBe(false);
    expect(isPublicCatalogueValue('AF_TENANT_ID', 'SPE_E5')).toBe(false);
  });
});
