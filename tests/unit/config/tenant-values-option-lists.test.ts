import { QUERY_SOURCE_NAMES, tenantValues } from '@adminforge/config';
import { KQL_SOURCES } from '@adminforge/schemas';

// AF_QUERY_SOURCES lists Query Studio sources by AdminForge's own names (config/example.env and docs/api.md show such
// lists), so the no-tenant-data guard doesn't treat it as tenant data — unless it holds anything else.

describe('AF_QUERY_SOURCES is an option list, not tenant data', () => {
  it('a list of source names is not tenant data (case and spaces ignored)', () => {
    expect(tenantValues({ AF_QUERY_SOURCES: 'resourceGraph,logAnalytics' })).toEqual([]);
    expect(tenantValues({ AF_QUERY_SOURCES: 'ResourceGraph, loganalytics, advancedHunting' })).toEqual([]);
  });

  it('anything else under the key still is', () => {
    expect(tenantValues({ AF_QUERY_SOURCES: 'resourceGraph,contoso-workspace' })).toEqual([
      'resourceGraph,contoso-workspace',
    ]);
  });

  it('the exemption only applies to the option-list keys', () => {
    expect(tenantValues({ AF_OTHER_LIST: 'resourceGraph,logAnalytics' })).toEqual([
      'resourceGraph,logAnalytics',
    ]);
  });

  it('names the same sources as the schemas', () => {
    expect([...QUERY_SOURCE_NAMES]).toEqual([...KQL_SOURCES]);
  });
});
