import {
  buildDesiredIdentities,
  licensedServices,
  TESTER_DIRECTORY_ROLES,
} from '@adminforge/cli/src/provision/identities-plan';

// The validation user gets the Exchange / SharePoint service admin roles only with AF_TEST_SERVICE_ADMIN_ROLES=true
// (admin file) and only where the tenant licenses the workload.
describe('test identities: opt-in, licence-aware service admin roles', () => {
  const base = { label: 'dev', domain: 'example.com' };

  it('reads licensed workloads from service plans', () => {
    expect(licensedServices(['EXCHANGE_S_ENTERPRISE', 'SHAREPOINTENTERPRISE', 'TEAMS1'])).toEqual({
      exchange: true,
      sharepoint: true,
    });
    expect(licensedServices(['AAD_PREMIUM', 'INTUNE_A'])).toEqual({ exchange: false, sharepoint: false });
    expect(licensedServices(['exchange_s_standard'])).toEqual({ exchange: true, sharepoint: false });
  });

  it('an unlicensed tenant keeps only the base roles, with or without the opt-in', () => {
    for (const serviceAdminRoles of [false, true]) {
      const d = buildDesiredIdentities({
        ...base,
        services: { exchange: false, sharepoint: false },
        serviceAdminRoles,
      });
      expect(d.testerRoles).toEqual([...TESTER_DIRECTORY_ROLES]);
      expect(d.withheldRoles).toEqual([]);
    }
    expect(buildDesiredIdentities(base).testerRoles).toEqual([...TESTER_DIRECTORY_ROLES]);
  });

  it('a licensed tenant without the opt-in withholds them (default)', () => {
    const d = buildDesiredIdentities({ ...base, services: { exchange: true, sharepoint: true } });
    expect(d.testerRoles).toEqual([...TESTER_DIRECTORY_ROLES]);
    expect(d.withheldRoles).toEqual(['Exchange Recipient Administrator', 'SharePoint Administrator']);
  });

  it('a licensed tenant with AF_TEST_SERVICE_ADMIN_ROLES=true adds them', () => {
    expect(
      buildDesiredIdentities({
        ...base,
        services: { exchange: true, sharepoint: true },
        serviceAdminRoles: true,
      }).testerRoles,
    ).toEqual([...TESTER_DIRECTORY_ROLES, 'Exchange Recipient Administrator', 'SharePoint Administrator']);
    const exchangeOnly = buildDesiredIdentities({
      ...base,
      services: { exchange: true },
      serviceAdminRoles: true,
    });
    expect(exchangeOnly.testerRoles).toEqual([...TESTER_DIRECTORY_ROLES, 'Exchange Recipient Administrator']);
    expect(exchangeOnly.withheldRoles).toEqual([]);
  });
});
