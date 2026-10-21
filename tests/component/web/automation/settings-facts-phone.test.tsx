import { screen } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../../support/web/fixtures/session';
import { settings } from '../../../support/web/fixtures/automation';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// M7 (design review): on a phone the 128 px label column left values about 95 px, so the audit-log fact wrapped into
// 13 lines and pills truncated ("Mock sig…", "Fixtures …"). Below `sm` the label sits above its value (full width);
// and the fresh-sign-in step-up is a short pill with the words that wrap under it, not a long pill that truncates.
const ADMIN = me({ roles: ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver', 'Portal.Admin'] });
const handlers = [
  ({ method, path }: { method: string; path: string }) =>
    method === 'GET' && path === '/api/admin/settings'
      ? { body: { ...settings(), authMode: 'mock', writeStepUp: 'freshSignIn' } }
      : undefined,
];

describe('Settings facts on a phone', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stacks each label above its value below sm, side by side from sm', async () => {
    renderApp({ session: ADMIN, path: '/settings', handlers });
    const label = await screen.findByText('Write step-up');
    expect(label.tagName).toBe('DT');
    expect(label).toHaveClass('sm:w-32');
    expect(label).not.toHaveClass('w-32');
    expect(label.parentElement).toHaveClass('flex-col', 'sm:flex-row');
  });

  it('keeps the step-up pill short, with what to do in words that wrap', async () => {
    renderApp({ session: ADMIN, path: '/settings', handlers });
    const pill = (await screen.findByText('Fresh sign-in only')).closest('[data-status]')!;
    expect(pill).toHaveAttribute('data-status', 'warn');
    expect(pill).toHaveTextContent(/^Fresh sign-in only$/);
    const hint = screen.getByText('Set WRITE_AUTH_CONTEXT to require MFA.');
    expect(pill.contains(hint)).toBe(false);
    expect(hint).toHaveClass('break-words');
    expect(await axeViolations()).toEqual([]);
  });
});
