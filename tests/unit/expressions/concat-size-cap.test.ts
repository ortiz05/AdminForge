import { compile, evaluate, lintExpressions, MAX_TEXT, validateExpressions } from '@adminforge/expressions';

// S-34: `&` is JSONata's own operator, so it grew text without the size check the string built-ins have. Evaluation
// rewrites every `&` into a size-checked concatenation: the same result as JSONata's, refused past MAX_TEXT like
// `$join`. Validation and lint still read the expression as written.
describe('& is size-checked like $join', () => {
  it('refuses a concatenation past MAX_TEXT characters', async () => {
    // 10 000 characters doubled 11 times: 20 480 000 characters.
    const grow = "$reduce([1..11], function($acc, $v) { $acc & $acc }, $pad('', 10000, 'x'))";
    await expect(evaluate(grow, {}, { timeoutMs: 5000 })).rejects.toThrow(
      `&: the result would exceed ${MAX_TEXT} characters`,
    );
    // The same growth below the cap works.
    await expect(
      evaluate(
        "$length($reduce([1..9], function($acc, $v) { $acc & $acc }, $pad('', 10000, 'x')))",
        {},
        {
          timeoutMs: 5000,
        },
      ),
    ).resolves.toBe(5_120_000);
  });

  it('refuses a value too large to turn into text', async () => {
    await expect(evaluate("'x' & [1..1000000]", {}, { timeoutMs: 5000 })).resolves.toHaveLength(6_888_898);
    // 1 001 strings of 10 000 characters: over 10 million characters of JSON text.
    await expect(evaluate("'x' & [1..1001].($pad('', 10000, 'x'))", {}, { timeoutMs: 5000 })).rejects.toThrow(
      /too large to turn into text/,
    );
  });

  it.each([
    ["'a' & 'b'"],
    ["'n=' & (0.1 + 0.2)"],
    ["'big=' & 1e21 & ',' & 123456789012345680000"],
    ["'b=' & true & ',' & false & ',' & null"],
    ["'u=' & undefinedField & '.'"],
    ['undefinedField & undefinedField'],
    ["'arr=' & [1, 'two', { 'three': 3 }]"],
    ["'obj=' & { 'a': [1, 2], 'b': { 'c': 1.5 } }"],
    ["'fn=' & function($x) { $x } & $string"],
    ["'seq=' & items.name"],
    ["'one=' & items[0].name"],
    ["(items.(name & '!'))[1]"],
    ["$join(items.(name & ':' & n), ',')"],
    ["items[name & 'x' = 'ax'].n"],
    ["{ 'k': 'a' & 'b' }.k & 'c'"],
    ["items^(name & '')[0].name"],
    ["items{ name & '#': n & '' }"],
  ])('%s evaluates as JSONata does', async (expr) => {
    const scope = {
      items: [
        { name: 'a', n: 1 },
        { name: 'b', n: 2.5 },
      ],
    };
    // The expression as written (validation's compile, not rewritten): JSONata's own `&`.
    const expected = await compile(expr).evaluate(scope);
    expect(await evaluate(expr, scope)).toEqual(JSON.parse(JSON.stringify(expected ?? null)) ?? undefined);
  });

  it('keeps errors JSONata raises for a value with no text form', async () => {
    await expect(evaluate("'x' & (1 / 0)")).rejects.toThrow(
      /D3001|Attempting to invoke string function on Infinity/,
    );
  });

  it('leaves the expression as written for validation and lint', () => {
    const ast = compile("'a' & params.q").ast() as unknown as { type: string; value: string };
    expect(ast).toMatchObject({ type: 'binary', value: '&' });
    expect(validateExpressions({ text: "${ 'a' & 'b' }" })).toEqual([]);
    expect(lintExpressions({ query: { $filter: "${ 'id eq ' & params.q }" } })).toHaveLength(1);
  });

  it('the internal concatenation is not callable from content', () => {
    expect(validateExpressions({ text: "${ $__afConcat('a', 'b') }" }).map((i) => i.message)).toContain(
      'Variables starting with $__af are reserved for AdminForge itself.',
    );
  });
});
