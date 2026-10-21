import { evaluate, MAX_TEXT } from '@adminforge/expressions';

// S-34 follow-up: the string built-ins refuse results past MAX_TEXT characters ($pad, $string, $join, $replace, `&`),
// but the encoders grew text unchecked: percent-encoding turns one character into up to nine (`é` is `%C3%A9`, `中`
// `%E4%B8%AD`), base64 three into four, and quoting for OData or KQL one into two. `$encodeUrl`,
// `$encodeUrlComponent`, `$base64encode` and AdminForge's `$encode`, `$odata`, `$odataSearch` and `$kql` now refuse an
// input whose result could pass MAX_TEXT; otherwise they answer as before.

const OPTS = { timeoutMs: 10_000 };
/** A text of `n` × 10,000 copies of `ch`, built inside the expression. */
const text = (n: number, ch = 'x') => `$join([1..${n}].($pad('', 10000, '${ch}')))`;

describe('encoders respect MAX_TEXT', () => {
  it.each([
    ['$encodeUrlComponent', 9],
    ['$encodeUrl', 9],
    ['$encode', 9],
  ])('%s refuses an input that could grow past MAX_TEXT (×%d), and encodes one that cannot', async (fn) => {
    // 1,200,000 characters: up to 10,800,000 once encoded.
    await expect(evaluate(`${fn}(${text(120)})`, {}, OPTS)).rejects.toThrow(
      `${fn}: the result could exceed ${MAX_TEXT} characters`,
    );
    // 1,100,000 characters: at most 9,900,000.
    await expect(evaluate(`$length(${fn}(${text(110, 'é')}))`, {}, OPTS)).resolves.toBe(6_600_000);
  });

  it('$base64encode refuses an input that could grow past MAX_TEXT, and encodes one that cannot', async () => {
    // 7,600,000 characters: 10,133,336 once encoded.
    await expect(evaluate(`$base64encode(${text(760)})`, {}, OPTS)).rejects.toThrow(
      `$base64encode: the result could exceed ${MAX_TEXT} characters`,
    );
    await expect(evaluate(`$length($base64encode(${text(750)}))`, {}, OPTS)).resolves.toBe(10_000_000);
  });

  it.each([
    ['$odata', 499, 4_990_002],
    ['$kql', 499, 4_990_002],
    ['$odataSearch', 500, 5_000_000],
  ])(
    '%s refuses an input that could double past MAX_TEXT, and quotes one that cannot',
    async (fn, fits, length) => {
      await expect(evaluate(`${fn}(${text(501)})`, {}, OPTS)).rejects.toThrow(
        `${fn}: the result could exceed ${MAX_TEXT} characters`,
      );
      await expect(evaluate(`$length(${fn}(${text(fits)}))`, {}, OPTS)).resolves.toBe(length);
    },
  );

  it('answers as before for ordinary values', async () => {
    expect(await evaluate("$encodeUrlComponent('a b/c?d=é')", {})).toBe('a%20b%2Fc%3Fd%3D%C3%A9');
    expect(await evaluate("$encodeUrl('https://example.com/a b?q=é')", {})).toBe(
      'https://example.com/a%20b?q=%C3%A9',
    );
    expect(await evaluate('$encode("O\'Brien/x")', {})).toBe("O'Brien%2Fx");
    expect(await evaluate("$base64encode('hi')", {})).toBe('aGk=');
    expect(await evaluate('$odata("O\'Brien")', {})).toBe("'O''Brien'");
    expect(await evaluate('$kql(\'say "hi"\')', {})).toBe('"say \\"hi\\""');
    expect(await evaluate('$odataSearch(\'a "b"\')', {})).toBe('a \\"b\\"');
    expect(await evaluate('$encodeUrlComponent(missing)', {})).toBeUndefined();
    expect(await evaluate('$base64encode(missing)', {})).toBeUndefined();
    await expect(evaluate("$encodeUrlComponent('\\uD800')", {})).rejects.toThrow();
  });
});
