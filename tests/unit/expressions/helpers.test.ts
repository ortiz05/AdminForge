import { assertGuid, daysAgo, daysUntil, encodePathSegment, evaluate, odataLiteral, odataSearchEscape, toIso } from '@adminforge/expressions';

describe('expression helpers', () => {
  it("$odata quotes and doubles single quotes: O'Brien → 'O''Brien'", async () => {
    expect(await evaluate(`$odata("O'Brien")`)).toBe("'O''Brien'");
    expect(odataLiteral("it's 'x'")).toBe("'it''s ''x'''");
    expect(odataLiteral(5)).toBe("'5'");
  });
  it('$odata refuses missing values', async () => {
    await expect(evaluate('$odata(params.missing)', { params: {} })).rejects.toThrow(/\$odata: value is missing/);
    expect(() => odataLiteral({})).toThrow(/expected a string/);
  });
  it('$odataSearch escapes backslashes and double quotes', async () => {
    expect(await evaluate('$odataSearch(q)', { q: 'a"b\\c' })).toBe('a\\"b\\\\c');
    expect(odataSearchEscape(undefined)).toBe('');
  });
  it('$encode encodes one path segment and refuses traversal', async () => {
    expect(await evaluate('$encode("a/b c?#")')).toBe('a%2Fb%20c%3F%23');
    expect(encodePathSegment("o'brien@example.com")).toBe("o'brien%40example.com");
    expect(() => encodePathSegment('..')).toThrow(/not a valid path segment/);
    await expect(evaluate('$encode(x)', {})).rejects.toThrow(/value is missing/);
  });
  it('$guid validates and lower-cases', async () => {
    expect(await evaluate('$guid("6F1C2F6E-0000-4000-8000-000000000001")')).toBe('6f1c2f6e-0000-4000-8000-000000000001');
    await expect(evaluate('$guid("6f1c2f6e")')).rejects.toThrow(/not a valid GUID: 6f1c2f6e/);
    expect(() => assertGuid(undefined)).toThrow(/not a valid GUID/);
  });
  it('$daysAgo, $iso and $daysUntil use scope.now when given', async () => {
    const now = '2026-03-10T12:00:00.000Z';
    expect(await evaluate('$daysAgo(30)', { now })).toBe('2026-02-08T12:00:00.000Z');
    expect(await evaluate('$iso()', { now })).toBe(now);
    expect(await evaluate('$iso(0)')).toBe('1970-01-01T00:00:00.000Z');
    expect(await evaluate('$iso("2026-01-01")')).toBe('2026-01-01T00:00:00.000Z');
    expect(await evaluate('$daysUntil("2026-03-20T12:00:00Z")', { now })).toBe(10);
    expect(await evaluate('$daysUntil("2026-03-09T12:00:00Z")', { now })).toBe(-1);
    await expect(evaluate('$iso("not a date")')).rejects.toThrow(/\$iso: not a valid date/);
    await expect(evaluate('$daysAgo("x")')).rejects.toThrow(/expected a number of days/);
  });
  it('plain functions match the expression helpers', () => {
    const now = new Date('2026-01-31T00:00:00Z');
    expect(daysAgo(1, now)).toBe('2026-01-30T00:00:00.000Z');
    expect(daysUntil('2026-02-02T00:00:00Z', now)).toBe(2);
    expect(toIso(undefined, now)).toBe('2026-01-31T00:00:00.000Z');
  });
  it('$join is JSONata built-in', async () => expect(await evaluate("$join(['a', 'b'], ', ')")).toBe('a, b'));
});
