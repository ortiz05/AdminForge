import { evaluate } from '@adminforge/connectors';

// Cost Management query/forecast take their filters as a POST body but only read; everything else under
// Microsoft.CostManagement (budgets, exports, scheduled actions) still needs write access.
const read = (path: string, method = 'POST') => evaluate('read', { service: 'arm', method, path }).allowed;

describe('read policy: Cost Management', () => {
  it.each([
    '/subscriptions/00000000-0000-4000-8000-0000000000a1/providers/Microsoft.CostManagement/query',
    '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-app/providers/Microsoft.CostManagement/query',
    '/providers/Microsoft.Management/managementGroups/mg-root/providers/Microsoft.CostManagement/forecast',
  ])('allows the read-only POST %s', (path) => {
    expect(read(path)).toBe(true);
  });

  it.each([
    '/subscriptions/00000000-0000-4000-8000-0000000000a1/providers/Microsoft.CostManagement/exports/nightly',
    '/subscriptions/00000000-0000-4000-8000-0000000000a1/providers/Microsoft.CostManagement/scheduledActions/a',
    '/subscriptions/00000000-0000-4000-8000-0000000000a1/providers/Microsoft.CostManagement/query/../exports/x',
    '/providers/Microsoft.CostManagement/query',
  ])('still refuses %s in read mode', (path) => {
    expect(read(path)).toBe(false);
  });
});
