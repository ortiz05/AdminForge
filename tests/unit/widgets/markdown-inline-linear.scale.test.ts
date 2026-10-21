import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '@adminforge/widgets';
import { tokenizeInline, type InlineToken } from '@adminforge/widgets/src/widgets/markdown/inline';

// The Markdown widget's inline tokenizer runs while the page renders, on the browser's main thread, over text that can
// carry values from data. Every token scan stops at the next delimiter of its own kind, so the work is linear in the
// text: 16,000 "[" used to take ~360 ms and 64,000 several seconds, because each "[" scanned to the end (S-21).
const BUDGET_MS = 250;
const N = 64_000;

const Link = ({ href, children }: { href: string; className?: string; children?: ReactNode }) =>
  createElement('a', { href }, children);
const renderMarkdown = (source: string) => renderToStaticMarkup(createElement(Markdown, { source, Link }));

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe('Markdown inline tokens on hostile input', () => {
  it.each([
    ['64,000 "["', '['.repeat(N)],
    ['"[a" repeated', '[a'.repeat(N / 2)],
    ['"[x](a" repeated (links never closed)', '[x](a'.repeat(N / 5)],
    ['a label then a target that never closes', `[${'a'.repeat(N / 2)}](${'b'.repeat(N / 2)}`],
    ['"](" repeated', '[a]('.repeat(N / 4)],
    ['64,000 "*"', '*'.repeat(N)],
    ['"**a" repeated', '**a'.repeat(N / 3)],
    ['"_a" repeated', '_a'.repeat(N / 2)],
    ['64,000 "`"', '`'.repeat(N)],
    ['64,000 "\\"', '\\'.repeat(N)],
    ['a mix of every delimiter', '[*_`\\]('.repeat(N / 7)],
  ])('%s renders quickly', { retry: 2 }, (_label, source) => {
    const { ms } = timed(() => renderMarkdown(source));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

const text = (t: string): InlineToken => ({ type: 'text', text: t });

describe('tokenizeInline', () => {
  it('reads code, strong, emphasis, links and escapes', () => {
    expect(tokenizeInline('a `b` **c** *d* _e_ __f__ [g](/p/x) \\*h')).toEqual([
      text('a '),
      { type: 'code', text: 'b' },
      text(' '),
      { type: 'strong', children: [text('c')] },
      text(' '),
      { type: 'em', children: [text('d')] },
      text(' '),
      { type: 'em', children: [text('e')] },
      text(' '),
      { type: 'strong', children: [text('f')] },
      text(' '),
      { type: 'link', target: '/p/x', children: [text('g')] },
      text(' '),
      text('*'),
      text('h'),
    ]);
  });

  it('nests emphasis and code inside a link label and emphasis inside strong', () => {
    expect(tokenizeInline('[**Open** `x`](https://learn.microsoft.com/)')).toEqual([
      {
        type: 'link',
        target: 'https://learn.microsoft.com/',
        children: [{ type: 'strong', children: [text('Open')] }, text(' '), { type: 'code', text: 'x' }],
      },
    ]);
    expect(tokenizeInline('**a _b_ c**')).toEqual([
      { type: 'strong', children: [text('a '), { type: 'em', children: [text('b')] }, text(' c')] },
    ]);
  });

  it('escaped brackets stay in a label; an unescaped "[" starts a new one', () => {
    expect(tokenizeInline('[\\[x\\]](/p/a)')).toEqual([
      { type: 'link', target: '/p/a', children: [text('['), text('x'), text(']')] },
    ]);
    expect(tokenizeInline('[a [b](/p/b)')).toEqual([
      text('[a '),
      { type: 'link', target: '/p/b', children: [text('b')] },
    ]);
  });

  it('a target ends at whitespace, ")" or "(" — what is left is text', () => {
    expect(tokenizeInline('[a](/p/x y)')).toEqual([text('[a](/p/x y)')]);
    expect(tokenizeInline('[a](/p/(x))')).toEqual([text('[a](/p/(x))')]);
    expect(tokenizeInline('[a]')).toEqual([text('[a]')]);
  });

  it('unclosed delimiters are text', () => {
    expect(tokenizeInline('**a')).toEqual([text('**a')]);
    expect(tokenizeInline('`a')).toEqual([text('`a')]);
    expect(tokenizeInline('a * b')).toEqual([text('a * b')]);
  });
});
