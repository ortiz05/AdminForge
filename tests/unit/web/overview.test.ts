import { plannedPage } from '@adminforge/web/src/lib/catalog';
import { healthStatus, OverviewResponse, skuName } from '@adminforge/web/src/lib/overview';
import { isActive } from '@adminforge/web/src/app/NavRail';
import { overview, overviewWithoutHealth } from '../../e2e/fixtures/overview';

describe('healthStatus', () => {
  it('maps Microsoft 365 states to plain words and a tone', () => {
    expect(healthStatus('serviceOperational')).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthStatus('serviceDegradation')).toEqual({ tone: 'warn', label: 'Degraded' });
    expect(healthStatus('serviceInterruption')).toEqual({ tone: 'crit', label: 'Interruption' });
    expect(healthStatus('investigating')).toEqual({ tone: 'info', label: 'Investigating' });
    expect(healthStatus('serviceRestored')).toEqual({ tone: 'ok', label: 'Restored' });
  });
  it('keeps unknown states readable instead of failing', () => {
    expect(healthStatus('somethingNew')).toEqual({ tone: 'neutral', label: 'something new' });
  });
});

describe('skuName', () => {
  it('names common SKUs and falls back to the part number', () => {
    expect(skuName('SPE_E5')).toBe('Microsoft 365 E5');
    expect(skuName('CUSTOM_THING')).toBe('CUSTOM THING');
  });
});

describe('OverviewResponse contract', () => {
  it('accepts the full and the partial (health refused) shapes', () => {
    expect(OverviewResponse.parse(overview()).org.name).toBe('Example Org');
    const partial = OverviewResponse.parse(overviewWithoutHealth());
    expect('error' in partial.health && partial.health.error.hint).toBe('Needs ServiceHealth.Read.All');
  });
  it('rejects a response without the organisation', () => {
    expect(() => OverviewResponse.parse({ counts: {}, skus: [], health: { items: [] } })).toThrow(/org/);
  });
  it('defaults missing provenance to an empty map', () => {
    const { provenance: _p, ...rest } = overview();
    expect(OverviewResponse.parse(rest).provenance).toEqual({});
  });
});

describe('plannedPage', () => {
  it('finds a description by nav key, then by the last path segment', () => {
    expect(plannedPage('users', '/identity/users')?.summary).toMatch(/Every user/);
    expect(plannedPage('unknown-key', '/azure/function-apps')?.summary).toMatch(/Function Apps/);
    expect(plannedPage(undefined, '/nothing/here')).toBeUndefined();
  });
});

describe('isActive', () => {
  it('matches the page and its children, but "/" only exactly', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/', '/identity/users')).toBe(false);
    expect(isActive('/identity/users', '/identity/users')).toBe(true);
    expect(isActive('/identity/users', '/identity/users/123')).toBe(true);
    expect(isActive('/identity/users', '/identity/users-old')).toBe(false);
  });
});

describe('plannedPage with namespaced keys', () => {
  it('resolves "identity.users" and "/p/m365.teams"', () => {
    expect(plannedPage('identity.users', '/p/identity.users')?.summary).toMatch(/Every user/);
    expect(plannedPage(undefined, '/p/m365.teams')?.summary).toMatch(/Teams/);
  });
});
