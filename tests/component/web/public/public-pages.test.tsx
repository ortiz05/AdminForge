import { screen } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../../axe';
import { renderApp } from '../automation/render';

// The signed-out and sign-in problem pages render without a session: no /api/me call, no redirect to sign-in.
describe('public pages', () => {
  beforeEach(() => __resetPrefsForTests());

  it('signed-out page offers sign-in without calling /api/me or redirecting', async () => {
    const { calls } = renderApp({ path: '/signed-out' });
    expect(await screen.findByRole('heading', { name: 'You’re signed out' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2F',
    );
    expect(screen.getByRole('link', { name: 'Use a different account' })).toHaveAttribute(
      'href',
      '/auth/login?account=choose&returnTo=%2F',
    );
    expect(calls.some((c) => c.url.startsWith('/api/me'))).toBe(false);
    expect(await axeViolations()).toEqual([]);
  });

  it('no portal role: explains the groups, shows the reference and Microsoft code, offers another account', async () => {
    const { calls } = renderApp({
      path: '/sign-in-problem?code=no_portal_role&ref=f801210a-a055-4aa4-be4f-ef299db12a8b&detail=AADSTS50105',
    });
    expect(
      await screen.findByRole('heading', { name: 'You don’t have access to AdminForge yet' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Reader group \(to view\) or the Operator group/)).toBeInTheDocument();
    expect(screen.getByText('AADSTS50105')).toBeInTheDocument();
    expect(screen.getByText('no_portal_role')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Use a different account' })).toBeInTheDocument();
    expect(screen.queryByText(/"error"/)).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/'))).toBe(false);
    expect(await axeViolations()).toEqual([]);
  });

  it('write-access failures say the person is still read-only and go back to the portal', async () => {
    renderApp({ path: '/sign-in-problem?code=arm_cancelled&during=arm&ref=abc123' });
    expect(await screen.findByRole('heading', { name: 'Write access wasn’t turned on' })).toBeInTheDocument();
    expect(screen.getByText(/still signed in with read-only access/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to AdminForge' })).toHaveAttribute('href', '/');
  });

  it('report downloads explain a missing role and an expired file', async () => {
    renderApp({ path: '/sign-in-problem?code=artifact_not_found&during=download&ref=r1' });
    expect(
      await screen.findByRole('heading', { name: 'This report file is no longer available' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Report download')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to AdminForge' })).toHaveAttribute('href', '/');
  });

  it('unknown or unsafe codes get general copy and are not echoed', async () => {
    renderApp({ path: `/sign-in-problem?code=${encodeURIComponent('<img src=x onerror=alert(1)>')}` });
    expect(
      await screen.findByRole('heading', { name: 'AdminForge couldn’t complete your sign-in' }),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('onerror');
  });
});
