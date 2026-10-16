import { cleanText, excerpt, htmlToText, cleanTitle } from '@adminforge/api/src/news/text';
import { parseFeed, parseFeedDate } from '@adminforge/api/src/news/xml';

// Feed text is untrusted: AdminForge keeps plain text only, and refuses XML that declares a DTD (XXE, entity bombs).
describe('news text', () => {
  it('turns HTML into one line of plain text, dropping scripts, styles and comments', () => {
    expect(
      htmlToText(
        '<p>Hello <b>admins</b>,</p><script>alert(1)</script><style>p{}</style><!-- x --><ul><li>one</li><li>two</li></ul>',
      ),
    ).toBe('Hello admins, one two');
  });

  it('decodes entities once, and never turns them back into markup', () => {
    expect(htmlToText('a &amp; b &lt;script&gt; &#169; &#x2014; &nbsp;c')).toBe('a & b <script> © — c');
    expect(htmlToText('&unknown; stays')).toBe('&unknown; stays');
  });

  it('removes control and bidi-override characters', () => {
    expect(cleanText('safe‮txt.exe\u0007 ​zero﻿')).toBe('safetxt.exe zero');
  });

  it('cuts excerpts on a word boundary with an ellipsis', () => {
    const text = 'The quick brown fox jumps over the lazy dog again and again';
    expect(excerpt(text, 20)).toBe('The quick brown fox…');
    expect(excerpt('short', 20)).toBe('short');
    expect(cleanTitle(`<b>${'x'.repeat(400)}</b>`).length).toBeLessThanOrEqual(300);
  });
});

describe('news XML', () => {
  const rss = (items: string) =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:a10="http://www.w3.org/2005/Atom"><channel><title>Example</title>${items}</channel></rss>`;

  it('reads RSS items: guid, link, categories, CDATA descriptions and a10:updated', () => {
    const feed = parseFeed(
      rss(
        '<item><guid isPermaLink="false">g1</guid><link>https://azure.microsoft.com/updates?id=1&amp;x=2</link>' +
          '<category>Retirements</category><category>Azure Monitor</category><title>A &amp; B</title>' +
          '<description><![CDATA[<p>Text &amp;amp; more</p>]]></description><pubDate>Tue, 14 Oct 2026 17:00:00 Z</pubDate>' +
          '<a10:updated>2026-10-15T09:00:00Z</a10:updated></item>',
      ),
    );
    expect(feed).toMatchObject({ format: 'rss', title: 'Example' });
    expect(feed.entries[0]).toMatchObject({
      id: 'g1',
      link: 'https://azure.microsoft.com/updates?id=1&x=2',
      title: 'A & B',
      categories: ['Retirements', 'Azure Monitor'],
      published: 'Tue, 14 Oct 2026 17:00:00 Z',
      updated: '2026-10-15T09:00:00Z',
    });
    // CDATA is never XML-decoded: the HTML entity is decoded once, later, by htmlToText.
    expect(feed.entries[0]!.summary).toBe('<p>Text &amp;amp; more</p>');
    expect(htmlToText(feed.entries[0]!.summary)).toBe('Text &amp; more');
  });

  it('reads Atom entries (alternate link, category terms) and OData properties', () => {
    const feed = parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:d="d" xmlns:m="m"><title>T</title>' +
        '<entry><id>urn:1</id><title type="text">E</title><link rel="edit" href="https://x.microsoft.com/edit"/>' +
        '<link rel="alternate" href="https://learn.microsoft.com/a"/><category term="Identity"/><updated>2026-10-01T00:00:00Z</updated>' +
        '<summary type="html">&lt;b&gt;S&lt;/b&gt;</summary>' +
        '<m:properties><d:Version>1.2.3</d:Version><d:IsPrerelease m:type="Edm.Boolean">false</d:IsPrerelease></m:properties></entry></feed>',
    );
    expect(feed.format).toBe('atom');
    expect(feed.entries[0]).toMatchObject({
      id: 'urn:1',
      title: 'E',
      link: 'https://learn.microsoft.com/a',
      categories: ['Identity'],
      summary: '<b>S</b>',
      properties: { Version: '1.2.3', IsPrerelease: 'false' },
    });
  });

  it('refuses DOCTYPE and ENTITY declarations (external entities, billion laughs)', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title></item></channel></rss>';
    expect(() => parseFeed(xxe)).toThrow(/declares a DTD/);
    const lol =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><rss><channel><title>&lol2;</title></channel></rss>';
    expect(() => parseFeed(lol)).toThrow(expect.objectContaining({ code: 'feed_unreadable' }));
    expect(() => parseFeed('<!-- c --><!ENTITY x "y"><rss/>')).toThrow(/DTD/);
  });

  it('refuses things that are not RSS or Atom', () => {
    expect(() => parseFeed('{"json": true}')).toThrow(/not XML/);
    expect(() => parseFeed('<html><body>Sign in</body></html>')).toThrow(/neither RSS nor Atom/);
    expect(() => parseFeed('<rss><channel><item><title>x</item></channel></rss>')).toThrow(/well-formed/);
  });

  it('does not expand undeclared entities and caps nesting', () => {
    const feed = parseFeed(rss('<item><title>&ent; &#65;</title></item>'));
    expect(feed.entries[0]!.title).toBe('&ent; A');
    const deep = `<rss><channel>${'<x>'.repeat(200)}${'</x>'.repeat(200)}</channel></rss>`;
    expect(() => parseFeed(deep)).toThrow(expect.objectContaining({ code: 'feed_unreadable' }));
  });

  it('parses RFC 822 and ISO dates; zone-less OData dates are UTC; 1900-01-01 (unlisted) is missing', () => {
    expect(parseFeedDate('Tue, 14 Oct 2026 17:00:00 Z')?.toISOString()).toBe('2026-10-14T17:00:00.000Z');
    expect(parseFeedDate('2026-10-14T18:00:00')?.toISOString()).toBe('2026-10-14T18:00:00.000Z');
    expect(parseFeedDate('1900-01-01T00:00:00')).toBeNull();
    expect(parseFeedDate('not a date')).toBeNull();
    expect(parseFeedDate('')).toBeNull();
  });
});
