import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { Markdown } from '@adminforge/web/src/runs/Markdown';

// The run Markdown (runbook sections, manual-step instructions, approval messages) renders on the browser's main
// thread over text that can carry values from data. Its link pattern let a label hold "[" and a target hold "(", so
// each "[" scanned to the end of the text: 64,000 "[" froze the page for seconds — the pattern S-21 fixed in the
// Markdown widget. A label now ends at the next "[" or "]" and a target at the next "(", ")" or whitespace, as there.
const BUDGET_MS = 250;
const N = 64_000;

function timed(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('run Markdown on hostile input', () => {
  it.each([
    ['64,000 "["', '['.repeat(N)],
    ['"[a" repeated', '[a'.repeat(N / 2)],
    ['"[x](a" repeated (links never closed)', '[x](a'.repeat(N / 5)],
    ['a label then a target that never closes', `[${'a'.repeat(N / 2)}](${'b'.repeat(N / 2)}`],
    ['"[a](" repeated', '[a]('.repeat(N / 4)],
    ['64,000 "*"', '*'.repeat(N)],
    ['"**a" repeated', '**a'.repeat(N / 3)],
    ['64,000 "`"', '`'.repeat(N)],
    ['64,000 "\\"', '\\'.repeat(N)],
    ['a mix of every delimiter', '[*`\\](_'.repeat(N / 7)],
  ])('%s renders quickly', { retry: 2 }, (_label, source) => {
    expect(timed(() => renderToStaticMarkup(<Markdown source={source} />))).toBeLessThan(BUDGET_MS);
  });
});

describe('run Markdown links', () => {
  it('an unescaped "[" starts a new label; escaped brackets stay in one', () => {
    const { container } = render(<Markdown source={'[a [b](/runs) and [\\[c\\]](/approvals)'} />);
    const links = [...container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['b', '/runs'],
      ['[c]', '/approvals'],
    ]);
    expect(container).toHaveTextContent('[a b and [c]');
  });

  it('a target ends at whitespace, "(" or ")": what is left stays text', () => {
    const { container } = render(<Markdown source={'[a](/runs x) [b](/p/(x)) [c](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('[a](/runs x) [b](/p/(x)) [c](javascript:alert(1))');
  });

  it('links, bold, italics and code inside a label still render', () => {
    render(<Markdown source={'[**Open** `x` *now*](https://learn.microsoft.com/)'} />);
    const link = screen.getByRole('link', { name: 'Open x now' });
    expect(link).toHaveAttribute('href', 'https://learn.microsoft.com/');
    expect(link.querySelector('strong')).toHaveTextContent('Open');
    expect(link.querySelector('code')).toHaveTextContent('x');
    expect(link.querySelector('em')).toHaveTextContent('now');
  });

  it('underscores are not emphasis (runbooks name settings like AF_REQUIRED_TAGS)', () => {
    const { container } = render(<Markdown source={'Set AF_REQUIRED_TAGS and _this_.'} />);
    expect(container.querySelector('em, strong')).toBeNull();
    expect(container).toHaveTextContent('Set AF_REQUIRED_TAGS and _this_.');
  });
});
