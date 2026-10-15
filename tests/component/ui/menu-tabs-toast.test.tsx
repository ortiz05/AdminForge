import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Button,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToastProvider,
  useToast,
  type ToastOptions,
} from '@adminforge/ui';
import { axeViolations } from '../axe';

describe('Menu', () => {
  function Harness({
    onCopy,
    onExport,
    onTheme,
  }: {
    onCopy: () => void;
    onExport: () => void;
    onTheme?: (v: string) => void;
  }) {
    return (
      <Menu>
        <MenuTrigger asChild>
          <Button>Actions</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>User</MenuLabel>
          <MenuItem onSelect={onCopy} shortcut="C">
            Copy object ID
          </MenuItem>
          <MenuItem onSelect={onExport}>Export sign-ins</MenuItem>
          <MenuCheckboxItem checked>Show disabled users</MenuCheckboxItem>
          <MenuSeparator />
          <MenuRadioGroup value="steel" onValueChange={onTheme}>
            <MenuRadioItem value="steel">Steel</MenuRadioItem>
            <MenuRadioItem value="daylight">Daylight</MenuRadioItem>
          </MenuRadioGroup>
          <MenuItem tone="danger" disabled>
            Delete user
          </MenuItem>
        </MenuContent>
      </Menu>
    );
  }

  it('opens with the keyboard, moves with arrows, selects with Enter, and restores focus', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    const onExport = vi.fn();
    render(<Harness onCopy={onCopy} onExport={onExport} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: /Copy object ID/ })).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Export sign-ins' })).toHaveFocus();
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Show disabled users' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(menu).getByRole('menuitemradio', { name: 'Steel' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Delete user' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(await axeViolations()).toEqual([]);
    await user.keyboard('{Enter}');
    expect(onExport).toHaveBeenCalledOnce();
    expect(onCopy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('ArrowDown on the trigger opens it; Escape closes it and restores focus', async () => {
    const user = userEvent.setup();
    const onTheme = vi.fn();
    render(<Harness onCopy={() => {}} onExport={() => {}} onTheme={onTheme} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Daylight' }));
    expect(onTheme).toHaveBeenCalledWith('daylight');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});

describe('Tabs', () => {
  it('arrow keys move between tabs and the panel follows; disabled tabs are skipped', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="User sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="audit" disabled>
            Audit
          </TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Account overview</TabsContent>
        <TabsContent value="groups">14 groups</TabsContent>
        <TabsContent value="audit">Audit trail</TabsContent>
        <TabsContent value="devices">2 devices</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tablist', { name: 'User sections' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Account overview');
    await user.tab();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('14 groups');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('2 devices');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Toast', () => {
  function Trigger({ options }: { options: ToastOptions }) {
    const { toast } = useToast();
    return (
      <button type="button" onClick={() => toast(options)}>
        Notify
      </button>
    );
  }

  it('shows title and description in a labelled notification region', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger
          options={{
            tone: 'ok',
            title: 'Sign-in disabled for adele.vance@example.com',
            description: 'Takes effect within minutes.',
          }}
        />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Notify' }));
    const toast = await screen.findByText('Sign-in disabled for adele.vance@example.com');
    expect(screen.getByText('Takes effect within minutes.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Notifications/ })).toBeInTheDocument();
    expect(toast.closest('li')).toHaveClass('af-toast');
    expect(await axeViolations()).toEqual([]);
  });

  it('runs its action and can be dismissed', async () => {
    const user = userEvent.setup();
    const onExtend = vi.fn();
    render(
      <ToastProvider>
        <Trigger
          options={{
            tone: 'warn',
            title: 'Write access ends in 5 minutes',
            action: { label: 'Extend', onClick: onExtend },
            duration: Infinity,
          }}
        />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Notify' }));
    await screen.findByText('Write access ends in 5 minutes');
    await user.click(screen.getByRole('button', { name: 'Extend' }));
    expect(onExtend).toHaveBeenCalledOnce();
    // The action also closes the toast.
    await waitFor(() => expect(screen.queryByText('Write access ends in 5 minutes')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Notify' }));
    await user.click(await screen.findByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByText('Write access ends in 5 minutes')).toBeNull());
  });

  it('useToast outside the provider throws a clear error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Trigger options={{ title: 'x' }} />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
