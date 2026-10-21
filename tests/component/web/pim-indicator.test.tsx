import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// The session rail shows your privileged roles and opens the activation playbook for an eligible one.
const ROLES = {
  roles: {
    active: [{ roleDefinitionId: '88d8e3e3-8f55-4a1e-953a-9b9898b8876b', displayName: 'Directory Readers' }],
    eligible: [
      { roleDefinitionId: 'fe930be7-5e62-47db-91af-98c3a49a38b1', displayName: 'User Administrator' },
    ],
  },
};
const capabilities =
  (body: unknown) =>
  ({ method, path }: { method: string; path: string }) =>
    method === 'GET' && path === '/api/me/capabilities' ? { body } : undefined;

describe('PIM indicator', () => {
  beforeEach(() => __resetPrefsForTests());

  it('shows counts and opens identity.pim-activate for an eligible role', async () => {
    renderApp({ path: '/', handlers: [capabilities(ROLES)] });
    const button = await screen.findByRole('button', {
      name: 'PIM (privileged roles): 1 active · 1 eligible',
    });
    await userEvent.click(button);
    expect(await screen.findByRole('menuitem', { name: 'Directory Readers' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'User Administrator' }));
    await waitFor(() =>
      expect(window.location.search + document.body.innerHTML).toMatch(
        /pim-activate|Activate an eligible role/,
      ),
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('explains when PIM can’t be read', async () => {
    renderApp({ path: '/', handlers: [capabilities({ roles: { active: null, eligible: null } })] });
    expect(
      await screen.findByRole('button', { name: /^PIM \(privileged roles\): .*Entra ID P2/ }),
    ).toBeInTheDocument();
  });
});
