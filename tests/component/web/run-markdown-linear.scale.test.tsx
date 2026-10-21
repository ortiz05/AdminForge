import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '@adminforge/web/src/runs/Markdown';

// The run Markdown (runbook sections, manual-step instructions, approval messages) renders on the browser's main
// thread over text that can carry values from data. Its link pattern let a label hold "[" and a target hold "(", so
// each "[" scanned to the end of the text: 64,000 "[" froze the page for seconds — the pattern S-21 fixed in the
// Markdown widget. A wall-clock budget, so it runs in the scale project (one file at a time); the link rules are in
// run-markdown-linear.test.tsx.
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
