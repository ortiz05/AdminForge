import { withRowLimit } from '@adminforge/api/src/probes/kql';

// Query Studio asks the service for max+1 rows. A second tabular statement would return its own, unlimited result,
// and a `render` anywhere used to switch the cap off: both are handled now.
describe('withRowLimit: one query, always capped', () => {
  it('keeps let/set/declare statements in front of the query', () => {
    expect(withRowLimit('let n = 5;\nset truncationmaxrecords = 10;\nT | take n', 10)).toBe(
      'let n = 5;\nset truncationmaxrecords = 10;\nT | take n\n| take 11',
    );
    expect(withRowLimit('declare query_parameters(x:int = 1);\nT | where a == x;', 3)).toBe(
      'declare query_parameters(x:int = 1);\nT | where a == x\n| take 4',
    );
  });

  it.each([
    'SigninLogs; AuditLogs',
    'SigninLogs | take 1;\nAuditLogs',
    'let x = 1;\nT1;\nT2',
    'print 1; print 2',
  ])('refuses a second tabular statement: %j', (q) =>
    expect(() => withRowLimit(q, 10)).toThrow(/Only one query can run at a time/),
  );

  it('ignores ; and | inside strings, comments and function bodies', () => {
    expect(withRowLimit(`T | where Name == "a;b|c" and Path has @'x;y' // trailing; comment`, 1)).toBe(
      `T | where Name == "a;b|c" and Path has @'x;y' // trailing; comment\n| take 2`,
    );
    expect(withRowLimit('let f = (x:int) { let y = x; y + 1 };\nT | extend z = f(1)', 1)).toBe(
      'let f = (x:int) { let y = x; y + 1 };\nT | extend z = f(1)\n| take 2',
    );
  });

  it('caps a query ending in render, keeping render last', () => {
    expect(withRowLimit('T | summarize count() by bin(TimeGenerated, 1h) | render timechart', 10)).toBe(
      'T | summarize count() by bin(TimeGenerated, 1h)\n| take 11\n| render timechart',
    );
    expect(withRowLimit('T | render barchart with (title="a | b")', 4)).toBe(
      'T\n| take 5\n| render barchart with (title="a | b")',
    );
  });

  it('refuses render that is not the last operator', () =>
    expect(() => withRowLimit('T | render timechart | take 100000000', 10)).toThrow(
      /render must be the last/,
    ));

  it('a column called render is not the render operator', () =>
    expect(withRowLimit('T | project renderTime', 1)).toBe('T | project renderTime\n| take 2'));

  it('refuses an empty query', () => expect(() => withRowLimit('// nothing\n;', 1)).toThrow(/empty/));
});
