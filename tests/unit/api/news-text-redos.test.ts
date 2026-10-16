import { cleanText, excerpt, htmlToText, MAX_SOURCE_CHARS } from '@adminforge/api/src/news/text';

// Feed text runs through htmlToText on the scheduler's event loop: crafted markup must not make it slow (every pass is
// linear, and no pattern sees more than MAX_SOURCE_CHARS), and the result must still be sensible text.
const BUDGET_MS = 250;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe('htmlToText on hostile input', () => {
  it.each([
    ['200,000 "<"', '<'.repeat(200_000)],
    ['100,000 "<p" without ">"', '<p'.repeat(100_000)],
    ['"<p" runs closed only at the very end', `${'<p'.repeat(100_000)}>`],
    ['an unterminated <script> with 200 KB after it', `Intro <script>${'x'.repeat(200_000)}`],
    ['many unterminated <script> tags', '<script>'.repeat(30_000)],
    ['an unterminated comment with 200 KB after it', `Intro <!--${'x'.repeat(200_000)}`],
    ['many "<!--" without an end', '<!--'.repeat(60_000)],
    ['an unterminated CDATA section', `<![CDATA[${'y'.repeat(200_000)}`],
    ['block tags with no end', '<div '.repeat(60_000)],
    ['entities without ";"', '&amp'.repeat(60_000)],
    ['8 MB of plain text', 'word '.repeat(1_600_000)],
  ])('%s finishes quickly', (_label, input) => {
    const { value, ms } = timed(() => htmlToText(input));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
  });

  it('still produces the text around hostile parts', () => {
    expect(htmlToText(`Before <script>${'x'.repeat(10_000)}`)).toBe('Before');
    expect(htmlToText('Before <!-- never closed')).toBe('Before');
    expect(htmlToText(`Kept${'<'.repeat(5)} text`)).toBe('Kept<<<<< text');
    expect(htmlToText('a < b and c > d')).toBe('a < b and c > d');
    expect(htmlToText('<p>One</p><p>Two<br>Three</p><b>bold</b>er')).toBe('One Two Three bolder');
    expect(htmlToText('<style>p{}</style><SCRIPT type="x">alert(1)</SCRIPT >Visible')).toBe('Visible');
    expect(htmlToText('<svg/>After a self-closing svg')).toBe('After a self-closing svg');
    expect(htmlToText('<![CDATA[Raw <b>text</b>]]>')).toBe('Raw text');
    expect(htmlToText('Cut off at the end <a href="https://exa')).toBe('Cut off at the end');
  });

  it('cleanText and excerpt are bounded too', () => {
    const big = `${' \t'.repeat(500_000)}end`;
    const a = timed(() => cleanText(big));
    expect(a.ms).toBeLessThan(BUDGET_MS);
    const b = timed(() => excerpt('word '.repeat(2_000_000), 300));
    expect(b.ms).toBeLessThan(BUDGET_MS);
    expect(b.value.length).toBeLessThanOrEqual(300);
  });
});

describe('invisible characters', () => {
  it.each([
    ['soft hyphen', '\u00ad'],
    ['Mongolian vowel separator', '\u180e'],
    ['word joiner', '\u2060'],
    ['invisible plus', '\u2064'],
    ['interlinear annotation anchor', '\ufff9'],
    ['interlinear annotation terminator', '\ufffb'],
    ['tag space', '\u{e0020}'],
    ['cancel tag', '\u{e007f}'],
    ['right-to-left override', '\u202e'],
    ['zero-width space', '\u200b'],
  ])('%s is removed', (_label, ch) => {
    expect(cleanText(`Res${ch}et pass${ch}word`)).toBe('Reset password');
    expect(htmlToText(`<p>Res${ch}et</p>`)).toBe('Reset');
  });

  it('keeps ordinary non-ASCII text', () => {
    expect(cleanText('Café — “quoted” · 日本語 ✓')).toBe('Café — “quoted” · 日本語 ✓');
  });
});
