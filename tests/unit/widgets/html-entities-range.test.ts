import { htmlToText, toText } from '@adminforge/widgets/src/lib/text';

// Text from the tenant (an app name, a group description, a message center post) is shown through toText. A numeric
// character reference that names no character must not throw — String.fromCodePoint does past U+10FFFF, and one
// throw used to blank the whole /p/<key> page for everyone. Such a reference shows as written (S-05), the same rule
// the API's feed text applies (portal/apps/api/src/news/text.ts).
describe('numeric character references in tenant text', () => {
  it.each([
    ['one past U+10FFFF (decimal)', '&#1114112;'],
    ['one past U+10FFFF (hex)', '&#x110000;'],
    ['far past U+10FFFF', '&#99999999999;'],
    ['a very long hex number', '&#xFFFFFFFFFFFFFFFFFFFFFFFF;'],
    ['a high surrogate', '&#xD800;'],
    ['a low surrogate', '&#xDFFF;'],
    ['a surrogate in decimal', '&#56320;'],
    ['zero', '&#0;'],
    ['an empty hex reference', '&#x;'],
    ['exponent notation', '&#1e5;'],
    ['a 0x prefix in a decimal reference', '&#0x41;'],
  ])('%s stays as written, without throwing', (_label, ref) => {
    expect(() => toText(`<b>${ref}</b>`)).not.toThrow();
    expect(toText(`<b>${ref}</b>`)).toBe(ref);
  });

  it('valid references still decode, at the edges of the range too', () => {
    expect(htmlToText('<p>&#65;&#x42;&#X43;</p>')).toBe('ABC');
    expect(htmlToText('<p>&#x1F600; &#128512;</p>')).toBe('😀 😀');
    expect(htmlToText('<p>&#1;&#xD7FF;&#xE000;&#x10FFFF;</p>')).toBe(
      String.fromCodePoint(1, 0xd7ff, 0xe000, 0x10ffff),
    );
    expect(htmlToText('<p>It&#39;s &amp; &lt;b&gt;</p>')).toBe("It's & <b>");
  });

  it('a hostile reference leaves the rest of the text intact', () => {
    expect(toText('<p>App &#1114112; owned by &#x41;lex</p>')).toBe('App &#1114112; owned by Alex');
  });

  it('text that is not HTML is returned as it is', () => {
    expect(toText('&#1114112;')).toBe('&#1114112;');
  });
});
