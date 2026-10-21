import { render, screen } from '@testing-library/react';
import { Panel, panel } from '@adminforge/ui';
import { axeViolations } from '../axe';

// D-12: a panel title ("Top home domains (inactive guests)") was cut to one line in a narrow panel. It wraps to two
// lines before it is cut, and long words break instead of overflowing the panel.

describe('Panel title', () => {
  it('wraps to two lines before truncating', async () => {
    const { container } = render(
      <Panel title="Top home domains (inactive guests) over the last ninety days">
        <p>Body</p>
      </Panel>,
    );
    const title = screen.getByRole('heading', { level: 2 });
    expect(title).toHaveTextContent('Top home domains (inactive guests) over the last ninety days');
    expect(title).toHaveClass('line-clamp-2', 'break-words');
    expect(title).not.toHaveClass('truncate');
    // Cut after two lines, the whole title is still there on hover.
    expect(title).toHaveAttribute('title', 'Top home domains (inactive guests) over the last ninety days');
    expect(screen.getByRole('region', { name: /Top home domains/ })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('the recipe is what every panel and widget uses', () => {
    const cls = panel().title();
    expect(cls).toContain('line-clamp-2');
    expect(cls).not.toMatch(/\btruncate\b/);
  });
});
