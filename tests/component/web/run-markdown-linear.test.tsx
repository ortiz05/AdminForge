import { render, screen } from '@testing-library/react';
import { Markdown } from '@adminforge/web/src/runs/Markdown';

// The run Markdown (runbook sections, manual-step instructions, approval messages) renders on the browser's main
// thread over text that can carry values from data. Its link pattern let a label hold "[" and a target hold "(", so
// each "[" scanned to the end of the text: 64,000 "[" froze the page for seconds — the pattern S-21 fixed in the
// Markdown widget. A label now ends at the next "[" or "]" and a target at the next "(", ")" or whitespace, as there.
// The timing cases are in run-markdown-linear.scale.test.tsx (the scale project runs one file at a time).
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
