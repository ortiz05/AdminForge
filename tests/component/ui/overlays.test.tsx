import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  Drawer,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '@adminforge/ui';
import { axeViolations } from '../axe';

describe('Tooltip', () => {
  it('shows supplementary text on keyboard focus and hides on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Last synchronised 4 minutes ago">
        <button type="button">Sync status</button>
      </Tooltip>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sync status' })).toHaveFocus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Last synchronised 4 minutes ago');
    expect(await axeViolations()).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('renders only the child when disabled or empty', () => {
    render(
      <div>
        <Tooltip content="x" disabled>
          <button type="button">A</button>
        </Tooltip>
        <Tooltip content="">
          <button type="button">B</button>
        </Tooltip>
      </div>,
    );
    expect(screen.getByRole('button', { name: 'A' })).not.toHaveAttribute('data-state');
    expect(screen.getByRole('button', { name: 'B' })).not.toHaveAttribute('data-state');
  });
});

describe('Dialog', () => {
  function Harness({ onSave }: { onSave: () => void }) {
    return (
      <Dialog
        trigger={<Button>Add members</Button>}
        title="Add members to SG-Example-Finance"
        description="Members get access to everything assigned to this group."
        footer={
          <>
            <DialogClose asChild>
              <Button intent="ghost">Cancel</Button>
            </DialogClose>
            <Button intent="primary" onClick={onSave}>
              Add 3 members
            </Button>
          </>
        }
      >
        <label>
          People
          <input />
        </label>
      </Dialog>
    );
  }

  it('opens from its trigger, traps focus inside, and Escape returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness onSave={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Add members' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Add members to SG-Example-Finance' });
    expect(dialog).toHaveAccessibleDescription('Members get access to everything assigned to this group.');
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Tab cycles within the dialog.
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(await axeViolations()).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('closes from the close button and footer actions work', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Add members' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add 3 members' }));
    expect(onSave).toHaveBeenCalledOnce();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has a description even when none is given', async () => {
    render(<Dialog open title="Plain" />);
    expect(await screen.findByRole('dialog', { name: 'Plain' })).toHaveAccessibleDescription('Plain');
  });
});

describe('ConfirmDialog', () => {
  it('typed mode blocks confirm until the exact text is typed, then confirms and closes', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        trigger={<Button intent="danger">Delete group…</Button>}
        title="Delete SG-Example-Finance?"
        description="Members lose access granted through this group."
        confirmLabel="Delete group"
        confirmText="SG-Example-Finance"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete group…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete SG-Example-Finance?' });
    // Focus starts on Cancel (Radix AlertDialog), never on the destructive action.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const confirm = within(dialog).getByRole('button', { name: 'Delete group' });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    const input = within(dialog).getByRole('textbox', { name: /Type SG-Example-Finance to confirm/ });
    await user.type(input, 'SG-Example-Financ');
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await axeViolations()).toEqual([]);

    await user.type(input, 'e');
    expect(confirm).not.toHaveAttribute('aria-disabled');
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Enter in the typed field confirms once the text matches', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Wipe device?"
        confirmLabel="Wipe device"
        confirmText="LAPTOP-042"
        onConfirm={onConfirm}
      />,
    );
    const input = await screen.findByRole('textbox');
    await user.type(input, 'LAPTOP-042{Enter}');
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('awaits an async confirm and shows progress', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <ConfirmDialog
        trigger={<Button>Revoke…</Button>}
        title="Revoke sessions?"
        confirmLabel="Revoke sessions"
        intent="armed"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke…' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Revoke sessions' });
    await user.click(confirm);
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    resolve();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Cancel closes without confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        trigger={<Button>Delete…</Button>}
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('Drawer', () => {
  function Harness({ modal }: { modal?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Inspect
        </button>
        <button type="button">Elsewhere</button>
        <Drawer
          open={open}
          onOpenChange={setOpen}
          modal={modal}
          eyebrow="User"
          title="Adele Vance"
          description="adele.vance@example.com"
        >
          <p>Details</p>
        </Drawer>
      </>
    );
  }

  it('shows a titled sheet with focus inside; Escape closes it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Inspect' }));
    const sheet = await screen.findByRole('dialog', { name: 'Adele Vance' });
    expect(sheet).toHaveAccessibleDescription('adele.vance@example.com');
    expect(within(sheet).getByText('User')).toHaveClass('af-eyebrow');
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(await axeViolations()).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('returns focus to the element that opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Inspect' });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Adele Vance' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('non-modal: the page stays usable and outside clicks do not close it', async () => {
    const user = userEvent.setup();
    render(<Harness modal={false} />);
    await user.click(screen.getByRole('button', { name: 'Inspect' }));
    const sheet = await screen.findByRole('dialog', { name: 'Adele Vance' });
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    await user.click(elsewhere);
    expect(sheet).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Adele Vance' })).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Popover', () => {
  it('opens from its trigger with the keyboard and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <button type="button">Filters</button>
        </PopoverTrigger>
        <PopoverContent aria-label="Filters">
          <label>
            Contains
            <input />
          </label>
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Filters' });
    await user.tab();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('textbox', { name: 'Contains' })).toBeInTheDocument();
    // Radix renders the content as role="dialog": callers must name it (aria-label).
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
