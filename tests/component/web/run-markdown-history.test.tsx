import { render, screen } from '@testing-library/react';
import {
  __resetHistoryForTests,
  forgetAllHistory,
  HISTORY_KEY,
  historyKey,
  readHistory,
  recordRun,
  setHistoryOwner,
} from '@adminforge/web/src/query/history';
import { Markdown } from '@adminforge/web/src/runs/Markdown';

describe('run Markdown (runbooks, manual steps, approvals) — L1', () => {
  it('links only to safe targets; /\\host and //host never become links', () => {
    const { container } = render(
      <Markdown
        source={[
          '[a](/\\evil.example.com) [b](//evil.example.com) [c](javascript:alert(1))',
          '[runs](/runs) [docs](https://learn.microsoft.com/) [mail](mailto:soc@example.com)',
        ].join('\n')}
      />,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/runs', 'https://learn.microsoft.com/', 'mailto:soc@example.com']);
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'runs' })).not.toHaveAttribute('target');
    expect(container).toHaveTextContent('a b c');
  });

  it('backslash escapes (how the server inserts data) show the characters, not markup', () => {
    const { container } = render(
      <Markdown
        source={'Disable \\[Open\\]\\(/admin\\) \\*\\*now\\*\\*?\n\n\\# not a heading\n\n\\- not a list'}
      />,
    );
    expect(container.querySelector('a, strong, h3, h4, ul')).toBeNull();
    expect(container).toHaveTextContent('Disable [Open](/admin) **now**?');
    expect(container).toHaveTextContent('# not a heading');
    expect(container).toHaveTextContent('- not a list');
  });

  it('still renders the authored subset', () => {
    const { container } = render(<Markdown source={'## Steps\n\n- **Call** the *user*\n- `run` it'} />);
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')).toHaveTextContent('Call');
    expect(container.querySelector('code')).toHaveTextContent('run');
  });
});

describe('Query Studio history is per user and leaves with sign-out (L15)', () => {
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const entry = (query: string) => ({
    source: 'resourceGraph' as const,
    query,
    ranAt: '2026-10-15T12:00:00.000Z',
  });

  beforeEach(() => {
    localStorage.clear();
    __resetHistoryForTests(null);
  });

  it('keeps each user’s history under their own key; nothing is stored without a signed-in owner', () => {
    recordRun(entry('resources | take 1'));
    expect(localStorage.length).toBe(0);
    setHistoryOwner(A);
    recordRun(entry('resources | where name == "a-secret-vm"'));
    expect(localStorage.getItem(historyKey(A))).toContain('a-secret-vm');
    setHistoryOwner(B);
    expect(readHistory()).toEqual([]);
    recordRun(entry('resources | take 2'));
    setHistoryOwner(A);
    expect(readHistory().map((e) => e.query)).toEqual(['resources | where name == "a-secret-vm"']);
  });

  it('drops the old unkeyed history and forgets everyone’s on sign-out', () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([entry('legacy')]));
    localStorage.setItem('adminforge.prefs', '{}');
    setHistoryOwner(A);
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull();
    recordRun(entry('mine'));
    setHistoryOwner(B);
    recordRun(entry('theirs'));
    forgetAllHistory();
    expect(localStorage.getItem(historyKey(A))).toBeNull();
    expect(localStorage.getItem(historyKey(B))).toBeNull();
    expect(localStorage.getItem('adminforge.prefs')).toBe('{}');
    expect(readHistory()).toEqual([]);
  });
});
