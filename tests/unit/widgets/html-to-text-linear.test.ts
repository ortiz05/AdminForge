import { htmlToText } from '@adminforge/widgets/src/lib/text';

// Widgets turn HTML in tenant data into text while they render (list and timeline rows, Markdown values), on the
// browser's main thread. Crafted markup — a command line or description full of "<" — must not freeze the page: every
// pass is linear in the input. (The API's feed text has the same rule: tests/unit/api/news-text-redos.test.ts.)
const BUDGET_MS = 250;
const N = 64_000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe('htmlToText on hostile input', () => {
  it.each([
    ['64,000 "<" after a tag', `<b>x</b>${'<'.repeat(N)}`],
    ['"<a x" repeated without ">"', '<a x'.repeat(N / 4)],
    ['"<a " repeated after a tag', `<b>x</b>${'<a '.repeat(N / 3)}`],
    ['"<li" repeated without ">"', `<b>x</b>${'<li'.repeat(N / 3)}`],
    ['"<li" runs whose only ">" was a removed script', `${'<li'.repeat(N / 3)}<script>x</script>`],
    ['"<li" runs whose only ">" was a line break', `${'<li'.repeat(N / 3)}<br>`],
    ['"<a x" runs whose only ">" ended a paragraph', `${'<a x'.repeat(N / 4)}</p>`],
    ['many unterminated <script> tags', `<b>x</b>${'<script>'.repeat(N / 8)}`],
    ['many unterminated <style> tags', `<b>x</b>${'<style>'.repeat(N / 7)}`],
    ['an unterminated <script> with 64 KB after it', `<b>x</b><script>${'y'.repeat(N)}`],
    ['a long run of spaces that never reaches a line end', `<p>a${' '.repeat(N)}b</p>`],
    ['"<br" with long whitespace and no ">"', `<b>x</b>${'<br     '.repeat(N / 8)}`],
    ['entities without ";"', `<b>x</b>${'&amp'.repeat(N / 4)}`],
  ])('%s finishes quickly', { retry: 2 }, (_label, input) => {
    const { ms } = timed(() => htmlToText(input));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('still turns HTML into text the way widgets show it', () => {
    expect(htmlToText('<p>One</p><p>Two<br>Three</p>')).toBe('One\n\nTwo\nThree');
    expect(htmlToText('<ul><li>First</li><li class="x">Second</li></ul>')).toBe('- First\n\n- Second');
    expect(htmlToText('Before<script type="x">alert(1)</script> <STYLE>p{}</STYLE>after<b>!</b>')).toBe(
      'Before after!',
    );
    // An unclosed script element loses its tag, like any other tag.
    expect(htmlToText('<b>a</b><script>never closed')).toBe('anever closed');
    expect(htmlToText('<b>x</b> a < b')).toBe('x a < b');
    expect(htmlToText('<b>x</b> <> y')).toBe('x <> y');
    expect(htmlToText('<p>line   \t</p>next')).toBe('line\n\nnext');
  });
});
