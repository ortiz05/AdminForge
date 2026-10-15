import { withRowLimit } from '@adminforge/api/src/probes/kql';

// Query Studio and KQL probes ask the service for max+1 rows instead of buffering everything it would return.
describe('withRowLimit', () => {
  it('appends a take of max+1 on its own line (safe after a trailing comment)', () => {
    expect(withRowLimit('AzureActivity // recent', 5000)).toBe('AzureActivity // recent\n| take 5001');
  });
  it('drops a trailing semicolon first', () => {
    expect(withRowLimit('let x = 1;\nAzureActivity;', 10)).toBe('let x = 1;\nAzureActivity\n| take 11');
  });
  it('leaves queries ending in render alone', () => {
    expect(withRowLimit('T | summarize count() by bin(TimeGenerated, 1h) | render timechart', 10)).toMatch(
      /render timechart$/,
    );
  });
});
