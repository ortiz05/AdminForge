import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { armStateAt } from '@adminforge/web/src/app/arm';
import { ShellContext, type ShellApi } from '@adminforge/web/src/app/shell-context';
import { LOCKED_REASON, WriteAction } from '@adminforge/web/src/app/WriteAction';
import { axeViolations } from '../axe';

const NOW = Date.now();
const shell = (armed: boolean): ShellApi => ({
  arm: armStateAt(
    armed
      ? { mode: 'armed', armedUntil: new Date(NOW + 30 * 60_000).toISOString(), armExtended: false }
      : { mode: 'read', armedUntil: null },
    NOW,
  ),
  openArmDialog: vi.fn(),
  openPalette: vi.fn(),
  extend: vi.fn(async () => {}),
  disarm: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
});
const withShell = (api: ShellApi, children: ReactNode) => (
  <ShellContext.Provider value={api}>{children}</ShellContext.Provider>
);

describe('WriteAction', () => {
  it('is locked in read mode: visible, focusable, explains why, does nothing', async () => {
    const onClick = vi.fn();
    render(withShell(shell(false), <WriteAction onClick={onClick}>Disable sign-in</WriteAction>));
    const btn = screen.getByRole('button', { name: 'Disable sign-in' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription(LOCKED_REASON);
    await userEvent.tab();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);
  });

  it('works once armed and carries the ember dot', async () => {
    const onClick = vi.fn();
    const { container } = render(
      withShell(shell(true), <WriteAction onClick={onClick}>Disable sign-in</WriteAction>),
    );
    const btn = screen.getByRole('button', { name: 'Disable sign-in' });
    expect(btn).not.toHaveAttribute('aria-disabled');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
    expect(container.querySelector('.af-armed-dot')).not.toBeNull();
  });
});
