import { ApiRequestError } from '@adminforge/web/src/lib/api';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ArmControl, type ArmControlProps } from '@adminforge/web/src/app/ArmControl';
import { armStateAt } from '@adminforge/web/src/app/arm';
import { axeViolations } from '../axe';

const NOW = Date.parse('2026-10-15T14:00:00Z');
const READ = armStateAt({ mode: 'read', armedUntil: null, armExtended: false }, NOW);
const ARMED = armStateAt(
  { mode: 'armed', armedUntil: new Date(NOW + (47 * 60 + 12) * 1000).toISOString(), armExtended: false },
  NOW,
);

function Harness(props: Partial<ArmControlProps>) {
  const [open, setOpen] = useState(false);
  return (
    <ArmControl
      canArm
      authMode="entra"
      arm={READ}
      tenantName="Example Org"
      dialogOpen={open}
      onDialogOpenChange={setOpen}
      onArm={async () => {}}
      onExtend={async () => {}}
      onDisarm={async () => {}}
      {...props}
    />
  );
}

describe('ArmControl · read mode', () => {
  it('shows Read-only and an Arm button', async () => {
    render(<Harness />);
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arm write access' })).toBeInTheDocument();
    expect(screen.queryByText(/Armed ·/)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('hides the Arm button for users without Portal.Operator', () => {
    render(<Harness canArm={false} />);
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Arm write access' })).not.toBeInTheDocument();
  });

  it('requires a reason, then sends {minutes, reason}', async () => {
    const onArm = vi.fn(async () => {});
    render(<Harness onArm={onArm} maxMinutes={240} />);
    await userEvent.click(screen.getByRole('button', { name: 'Arm write access' }));
    const dialog = await screen.findByRole('dialog', { name: 'Arm write access' });
    expect(dialog).toHaveTextContent('Example Org');
    expect(dialog).toHaveTextContent('up to 4 hours');

    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign-in' }));
    expect(onArm).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Reason')).toHaveAccessibleDescription(/at least 5 characters/);

    await userEvent.type(screen.getByLabelText('Reason'), 'INC-4821 locked-out user');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign-in' }));
    expect(onArm).toHaveBeenCalledWith({ minutes: 60, reason: 'INC-4821 locked-out user' });
    expect(await axeViolations()).toEqual([]);
  });

  it('shows why arming failed and lets you try again', async () => {
    const onArm = vi.fn(async () => {
      throw new ApiRequestError(
        403,
        'forbidden',
        'Arming write access needs the Portal.Operator role.',
        'Ask a portal administrator to add you to the AdminForge Operator group.',
      );
    });
    render(<Harness onArm={onArm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Arm write access' }));
    await userEvent.type(await screen.findByLabelText('Reason'), 'Quarterly review');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign-in' }));
    // The message and the next step (which group to join), not just the message.
    expect(await screen.findByRole('alert')).toHaveTextContent('needs the Portal.Operator role');
    expect(screen.getByRole('alert')).toHaveTextContent('AdminForge Operator group');
    expect(screen.getByRole('button', { name: 'Continue to sign-in' })).not.toHaveAttribute('aria-busy');
  });

  it('labels the confirm button for mock sign-in', async () => {
    render(<Harness authMode="mock" />);
    await userEvent.click(screen.getByRole('button', { name: 'Arm write access' }));
    expect(await screen.findByRole('button', { name: 'Arm now' })).toBeInTheDocument();
  });
});

describe('ArmControl · armed', () => {
  it('shows the countdown, Extend (once) and Disarm', async () => {
    const onExtend = vi.fn(async () => {});
    const onDisarm = vi.fn(async () => {});
    const { rerender } = render(<Harness arm={ARMED} onExtend={onExtend} onDisarm={onDisarm} />);
    expect(screen.getByText('Armed · 47:12')).toBeInTheDocument();
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Extend' }));
    expect(onExtend).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Disarm' }));
    expect(onDisarm).toHaveBeenCalledOnce();
    expect(await axeViolations()).toEqual([]);

    rerender(<Harness arm={{ ...ARMED, canExtend: false }} />);
    expect(screen.queryByRole('button', { name: 'Extend' })).not.toBeInTheDocument();
  });

  it('keeps the ticking countdown out of live regions, but announces the 5-minute mark once', async () => {
    const { rerender } = render(<Harness arm={ARMED} />);
    expect(screen.getByText('Armed · 47:12').closest('[aria-live]')).toHaveAttribute('aria-live', 'off');
    rerender(<Harness arm={{ ...ARMED, remainingMs: 4 * 60_000 }} />);
    await waitFor(() => expect(screen.getByText('Write access ends in 5 minutes.')).toBeInTheDocument());
  });
});
