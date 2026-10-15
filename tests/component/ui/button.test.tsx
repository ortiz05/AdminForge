import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, button, IconButton } from '@adminforge/ui';
import { axeViolations } from '../axe';

describe('Button', () => {
  it('renders its label and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save changes</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('a locked action stays focusable, explains why, and does nothing', async () => {
    const onClick = vi.fn();
    render(
      <Button locked="Arm write access to use this." onClick={onClick}>
        Disable sign-in
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Disable sign-in' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAccessibleDescription('Arm write access to use this.');
    await userEvent.tab();
    expect(btn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('pending blocks clicks and reports busy', async () => {
    const onClick = vi.fn();
    render(
      <Button pending onClick={onClick}>
        Saving
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Saving' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('activates from the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run playbook</Button>);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('merges token classes without dropping colour or size (tailwind-merge knows our tokens)', () => {
    const cls = button({ intent: 'primary', class: 'text-2xs' });
    expect(cls).toContain('text-on-accent');
    expect(cls).toContain('text-2xs');
    expect(button({ intent: 'secondary', class: 'bg-panel' })).not.toContain('bg-raised');
  });

  it('has no axe violations in any intent or state', async () => {
    const { container } = render(
      <div>
        {(['primary', 'secondary', 'ghost', 'danger', 'armed'] as const).map((intent) => (
          <Button key={intent} intent={intent}>
            {intent}
          </Button>
        ))}
        <Button locked="Arm write access to use this.">Locked</Button>
        <Button pending>Pending</Button>
        <Button disabled>Disabled</Button>
      </div>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('IconButton', () => {
  it('is named by its label and shows it as a tooltip on focus', async () => {
    const onClick = vi.fn();
    render(<IconButton label="Refresh" icon={<svg />} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'Refresh' });
    await userEvent.tab();
    expect(btn).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Refresh');
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
    expect(await axeViolations()).toEqual([]);
  });
});
