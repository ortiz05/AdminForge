import {
  evaluate,
  HELPER_NAMES,
  kqlLiteral,
  lintExpressions,
  renderString,
  SECURE_RANDOM_ALPHABET,
  secureRandom,
} from '@adminforge/expressions';

describe('$kql', () => {
  it.each([
    ['plain', '"plain"'],
    ["O'Brien", `"O'Brien"`],
    ['say "hi"', '"say \\"hi\\""'],
    ['C:\\temp', '"C:\\\\temp"'],
    ['line1\nline2\ttab\r', '"line1\\nline2\\ttab\\r"'],
    ['', '""'],
  ])('quotes %j', (input, out) => expect(kqlLiteral(input)).toBe(out));
  it('quotes numbers and booleans and refuses missing values and objects', () => {
    expect(kqlLiteral(5)).toBe('"5"');
    expect(kqlLiteral(true)).toBe('"true"');
    expect(() => kqlLiteral(undefined)).toThrow(/missing/);
    expect(() => kqlLiteral(null)).toThrow(/missing/);
    expect(() => kqlLiteral(['a'])).toThrow(/expected a string, got array/);
    expect(() => kqlLiteral({ a: 1 })).toThrow(/expected a string/);
  });
  it('is available in expressions and keeps an injection attempt inside the literal', async () => {
    const q = await renderString('resources | where name == ${ $kql(params.name) } | take 1', {
      params: { name: 'x" or 1==1 //' },
    });
    expect(q).toBe('resources | where name == "x\\" or 1==1 //" | take 1');
  });
});

describe('$uuid', () => {
  it('returns a fresh v4 GUID each time', async () => {
    const a = await evaluate('$uuid()');
    const b = await evaluate('$uuid()');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
  it('is a documented helper', () =>
    expect(HELPER_NAMES).toEqual(expect.arrayContaining(['kql', 'uuid', 'secureRandom'])));
});

describe('$secureRandom', () => {
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/];
  it('draws the requested length from the default alphabet with every character class', () => {
    for (let i = 0; i < 200; i++) {
      const s = secureRandom(8);
      expect(s).toHaveLength(8);
      expect([...s].every((c) => SECURE_RANDOM_ALPHABET.includes(c))).toBe(true);
      for (const re of classes) expect(s).toMatch(re);
    }
  });
  it('is available in expressions (default and custom alphabet)', async () => {
    expect(await evaluate('$secureRandom(24)')).toMatch(/^[A-Za-z0-9!@#%^*\-_=+?]{24}$/);
    expect(await evaluate('$secureRandom(12, "ab")')).toMatch(/^[ab]{12}$/);
  });
  it('guarantees the classes present in a custom alphabet once the length reaches 8', () => {
    for (let i = 0; i < 100; i++) {
      const s = secureRandom(8, 'AB12');
      expect(s).toMatch(/[AB]/);
      expect(s).toMatch(/[12]/);
    }
  });
  it('makes no class guarantee below 8 characters', () => expect(secureRandom(3, 'ab')).toMatch(/^[ab]{3}$/));
  it('uses the injected CSPRNG for both picking and shuffling', () => {
    const calls: number[] = [];
    const out = secureRandom(8, 'AB', (max) => {
      calls.push(max);
      return 0;
    });
    expect(out).toHaveLength(8);
    // 2 class picks (upper only: A/B are both upper → one class) … then fills and 7 shuffle swaps.
    expect(calls.filter((m) => m === 2).length).toBeGreaterThanOrEqual(8);
    expect(calls).toContain(8);
  });
  it('spreads values across the alphabet', () => {
    const seen = new Set(secureRandom(256, 'abcd'));
    expect(seen).toEqual(new Set('abcd'));
  });
  it.each([
    [0, undefined, /length must be a whole number from 1 to 256/],
    [257, undefined, /1 to 256/],
    [2.5, undefined, /whole number/],
    ['8', undefined, /whole number/],
    [8, 'a', /at least 2 distinct/],
    [8, 'aaaa', /at least 2 distinct/],
    [8, 5, /alphabet must be a string/],
  ])('refuses length %j alphabet %j', (length, alphabet, message) =>
    expect(() => secureRandom(length, alphabet)).toThrow(message),
  );
});

describe('lintExpressions — KQL', () => {
  const warn = (query: string, extra: Record<string, unknown> = {}) =>
    lintExpressions({ datasources: { q: { source: 'resourceGraph', query } }, ...extra }).map(
      (w) => w.message,
    );
  it('flags params interpolated straight into the query text', () =>
    expect(warn("resources | where name == '${ params.name }'")).toEqual([
      expect.stringMatching(/without \$kql\(\)/),
    ]));
  it('flags user data concatenated into the query', () => {
    expect(warn('${ "resources | where name == \'" & params.name & "\'" }')).toHaveLength(1);
    expect(
      lintExpressions({ steps: [{ type: 'logAnalytics', query: 'T | where x == "${ inputs.x }"' }] }),
    ).toHaveLength(1);
    expect(
      lintExpressions({ check: { kind: 'kql', query: '${ "T | where u == " & row.upn }' } }),
    ).toHaveLength(1);
  });
  it('accepts $kql, $guid, other helpers, env and literal allowlists', () => {
    expect(warn('resources | where name == ${ $kql(params.name) }')).toEqual([]);
    expect(
      warn('resources ${ params.sub ? "| where subscriptionId == \'" & $guid(params.sub) & "\'" }'),
    ).toEqual([]);
    expect(warn("T | where n == ${ $kql($replace(params.n, /[^a-z]/, '')) }")).toEqual([]);
    expect(warn('T | where tag == ${ $kql(env.AF_REQUIRED_TAGS) } | take ${ env.AF_X }')).toEqual([]);
    expect(
      warn(
        "alerts ${ params.sev in ['Sev0', 'Sev1'] ? \"| where severity == '\" & params.sev & \"'\" : '' }",
      ),
    ).toEqual([]);
    expect(warn("alerts | where t > ago(${ params.range in ['1d', '7d'] ? params.range : '1d' })")).toEqual(
      [],
    );
  });
  it('still flags the else branch of an allowlist and a non-literal list', () => {
    expect(warn("T ${ params.s in ['a'] ? '' : \"| where s == '\" & params.s & \"'\" }")).toHaveLength(1);
    expect(
      warn('T ${ params.s in params.allowed ? "| where s == \'" & params.s & "\'" : \'\' }'),
    ).toHaveLength(1);
  });
  it('trusts the param the advanced KQL filter builder compiles', () => {
    const def = (dialect: string) => ({
      filters: { advanced: { dialect, param: 'where' } },
      datasources: {
        q: { source: 'resourceGraph', query: "resources ${ params.where ? '| where ' & params.where }" },
      },
    });
    expect(lintExpressions(def('kql'))).toEqual([]);
    expect(lintExpressions(def('odata'))).toHaveLength(1);
  });
  it('leaves $filter linting as it was', () =>
    expect(
      lintExpressions({ request: { query: { $filter: '${ "a eq \'" & params.q & "\'" }' } } })[0]!.message,
    ).toMatch(/\$odata\(\)/));
});
