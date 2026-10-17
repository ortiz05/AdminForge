import { evaluate } from '@adminforge/connectors';

// Azure Billing reads cost for a whole billing account (EA enrollment, MCA billing account) or MCA billing profile with
// the same read-only Cost Management query/forecast POSTs; nothing else under Microsoft.Billing is a read POST.
const read = (path: string, method = 'POST') => evaluate('read', { service: 'arm', method, path }).allowed;
const ACCOUNT =
  '/providers/Microsoft.Billing/billingAccounts/00000000-0000-4000-8000-0000000000b1:example_2019-05-31';

describe('read policy: Cost Management at billing scope', () => {
  it.each([
    `${ACCOUNT}/providers/Microsoft.CostManagement/query`,
    `${ACCOUNT}/providers/Microsoft.CostManagement/forecast`,
    `${ACCOUNT}/billingProfiles/EXAM-PL00-0001/providers/Microsoft.CostManagement/query`,
    '/providers/Microsoft.Billing/billingAccounts/12345678/providers/Microsoft.CostManagement/query',
  ])('allows the read-only POST %s', (path) => {
    expect(read(path)).toBe(true);
  });

  it.each([
    // Billing changes and document downloads stay write requests.
    `${ACCOUNT}/invoices/G000000001/download`,
    `${ACCOUNT}/billingProfiles/EXAM-PL00-0001/invoiceSections/x/providers/Microsoft.CostManagement/query`,
    `${ACCOUNT}/providers/Microsoft.CostManagement/exports/nightly`,
    `${ACCOUNT}/providers/Microsoft.CostManagement/query/../exports/x`,
    '/providers/Microsoft.Billing/billingAccounts/providers/Microsoft.CostManagement/query',
    '/providers/Microsoft.Billing/billingAccounts/a/b/providers/Microsoft.CostManagement/query',
  ])('still refuses %s in read mode', (path) => {
    expect(read(path)).toBe(false);
  });

  it('reads invoices and billing accounts with GET only', () => {
    expect(read(`${ACCOUNT}/invoices`, 'GET')).toBe(true);
    expect(read('/providers/Microsoft.Billing/billingAccounts', 'GET')).toBe(true);
    expect(read(`${ACCOUNT}/billingProfiles/EXAM-PL00-0001`, 'PATCH')).toBe(false);
  });
});
