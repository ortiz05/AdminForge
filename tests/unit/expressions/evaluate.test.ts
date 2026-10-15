import { clearCompileCache, compile, compileCacheSize, evaluate, ExpressionError, ExpressionTimeoutError } from '@adminforge/expressions';

describe('evaluate', () => {
  it('evaluates against the scope (async)', async () => {
    const p = evaluate('params.userType', { params: { userType: 'Guest' } });
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe('Guest');
  });
  it('returns plain arrays and objects (no JSONata sequence flags)', async () => {
    const r = await evaluate('items[n > 1].{ "id": id }', { items: [{ n: 1, id: 'a' }, { n: 2, id: 'b' }, { n: 3, id: 'c' }] });
    expect(r).toEqual([{ id: 'b' }, { id: 'c' }]);
    expect(Object.keys(r as object)).toEqual(['0', '1']);
  });
  it('returns undefined for missing paths', async () => expect(await evaluate('params.nope', { params: {} })).toBeUndefined());
  it('names the expression in errors', async () => {
    const err = (await evaluate('$number("abc") + 1').catch((e: unknown) => e)) as ExpressionError;
    expect(err).toBeInstanceOf(ExpressionError);
    expect(err.message).toMatch(/in expression: \$number\("abc"\) \+ 1/);
    expect(err.expression).toBe('$number("abc") + 1');
  });
  it('reports syntax errors with position', () => {
    try {
      compile('items[');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionError);
      expect((err as ExpressionError).message).toMatch(/^Invalid expression: .* — in expression: items\[/);
      expect((err as ExpressionError).position).toBeGreaterThan(0);
    }
  });
  it('times out runaway expressions after 250 ms', async () => {
    const started = Date.now();
    const err = (await evaluate('($loop := function($n) { $loop($n + 1) }; $loop(0))').catch((e: unknown) => e)) as ExpressionError;
    expect(err).toBeInstanceOf(ExpressionTimeoutError);
    expect(err.message).toMatch(/timed out after 250 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('honours a custom timeout', async () => {
    const err = (await evaluate('($loop := function($n) { $loop($n + 1) }; $loop(0))', {}, { timeoutMs: 20 }).catch((e: unknown) => e)) as ExpressionError;
    expect(err).toBeInstanceOf(ExpressionTimeoutError);
    expect(err.message).toMatch(/after 20 ms/);
  });
  it('limits recursion depth', async () => {
    await expect(evaluate('($f := function($n) { 1 + $f($n + 1) }; $f(0))')).rejects.toThrow(/too deeply/);
    expect(await evaluate('($f := function($n) { $n = 0 ? 0 : 1 + $f($n - 1) }; $f(20))')).toBe(20);
  });
  it('caches compiled expressions (LRU)', () => {
    clearCompileCache();
    const a = compile('a + 1');
    expect(compile('a + 1')).toBe(a);
    expect(compile('a + 1', { timeoutMs: 100 })).not.toBe(a);
    expect(compileCacheSize()).toBe(2);
  });
  it('has no I/O helpers beyond JSONata built-ins', async () => {
    await expect(evaluate('$fetch("https://example.com")')).rejects.toThrow(ExpressionError);
  });
});
