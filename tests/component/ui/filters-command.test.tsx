import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandGroup, CommandItem, CommandPalette, FilterBar, type Facet } from '@adminforge/ui';
import { axeViolations } from '../axe';

const FACETS: Facet[] = [
  {
    id: 'status',
    label: 'Status',
    options: [
      { value: 'Enabled', count: 4 },
      { value: 'Disabled', count: 1 },
    ],
  },
  {
    id: 'department',
    label: 'Department',
    options: [
      { value: 'Finance', count: 2 },
      { value: 'Legal', count: 3 },
    ],
  },
];

function Harness({
  onValues,
  onSearch,
  onClear,
}: {
  onValues?: (id: string, v: string[]) => void;
  onSearch?: (v: string) => void;
  onClear?: () => void;
}) {
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');
  return (
    <FilterBar
      facets={FACETS}
      values={values}
      onValuesChange={(id, v) => {
        setValues((all) => ({ ...all, [id]: v }));
        onValues?.(id, v);
      }}
      search={search}
      onSearchChange={(v) => {
        setSearch(v);
        onSearch?.(v);
      }}
      searchPlaceholder="Search name or UPN…"
      extraChips={[{ id: 'upn', label: 'UPN', value: 'contains “adele”', onRemove: () => {} }]}
      onClear={() => {
        setValues({});
        setSearch('');
        onClear?.();
      }}
    >
      <span>12 rows</span>
    </FilterBar>
  );
}

describe('FilterBar', () => {
  it('searches as you type', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const { container } = render(<Harness onSearch={onSearch} />);
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await user.type(search, 'ade');
    expect(onSearch).toHaveBeenLastCalledWith('ade');
    expect(screen.getByText('12 rows')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('facet popovers toggle values, then show removable chips; Clear resets', async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    const onClear = vi.fn();
    render(<Harness onValues={onValues} onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: 'Status' }));
    const enabled = await screen.findByRole('checkbox', { name: 'Enabled' });
    await user.click(enabled);
    expect(onValues).toHaveBeenLastCalledWith('status', ['Enabled']);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Enabled' })).toBeNull());

    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(within(chips).getByRole('button', { name: 'Remove filter Status: Enabled' })).toBeInTheDocument();
    expect(
      within(chips).getByRole('button', { name: 'Remove filter UPN: contains “adele”' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Status, 1 selected' })).toBeInTheDocument();

    await user.click(within(chips).getByRole('button', { name: 'Remove filter Status: Enabled' }));
    expect(onValues).toHaveBeenLastCalledWith('status', []);

    await user.click(screen.getByRole('button', { name: 'Department' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Legal' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('facet counts are shown next to options', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Department' }));
    const group = await screen.findByRole('group', { name: 'Department' });
    expect(group).toHaveTextContent('Legal');
    expect(group).toHaveTextContent('3');
  });

  it('an open facet popover has no axe violations', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Status' }));
    await screen.findByRole('checkbox', { name: 'Enabled' });
    expect(await axeViolations()).toEqual([]);
  });
});

describe('CommandPalette', () => {
  function Harness({ onSelect }: { onSelect: (v: string) => void }) {
    const [open, setOpen] = useState(true);
    return (
      <CommandPalette open={open} onOpenChange={setOpen} placeholder="Jump to a page…">
        <CommandGroup heading="Pages">
          <CommandItem value="Users Identity" hint="Identity" onSelect={() => onSelect('users')}>
            Users
          </CommandItem>
          <CommandItem value="Groups Identity" hint="Identity" onSelect={() => onSelect('groups')}>
            Groups
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem
            value="Switch theme Daylight"
            shortcut={['Ctrl', 'D']}
            onSelect={() => onSelect('theme')}
          >
            Switch theme: Daylight
          </CommandItem>
        </CommandGroup>
      </CommandPalette>
    );
  }

  it('is a named dialog with a combobox input and grouped options', async () => {
    render(<Harness onSelect={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox');
    await waitFor(() => expect(input).toHaveFocus());
    expect(within(dialog).getAllByRole('option')).toHaveLength(3);
    expect(within(dialog).getByText('Pages')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('typing filters; arrows move; Enter selects', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox');
    await user.type(input, 'theme');
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(1));
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('theme');

    await user.clear(input);
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(3));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('groups');
  });

  it('shows the empty message when nothing matches, and Escape closes', async () => {
    const user = userEvent.setup();
    render(<Harness onSelect={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(dialog).getByRole('combobox'), 'zzzz');
    expect(await within(dialog).findByText(/No matches/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
