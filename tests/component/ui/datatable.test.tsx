import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, DataTable, type DataColumn, type StatusValue } from '@adminforge/ui';
import { axeViolations } from '../axe';

interface User {
  id: string;
  name: string;
  upn: string;
  status: StatusValue;
  lastSignIn: string | null;
  mfa: number;
  licences: string[];
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ok = { tone: 'ok', label: 'Enabled' } as const;
const crit = { tone: 'crit', label: 'Compromised' } as const;
const off = { tone: 'neutral', label: 'Disabled' } as const;

const USERS: User[] = [
  {
    id: '0a1b2c3d-0000-4000-8000-000000000001',
    name: 'Adele Vance',
    upn: 'adele.vance@example.com',
    status: ok,
    lastSignIn: ago(5 * 60_000),
    mfa: 3,
    licences: ['M365 E5'],
  },
  {
    id: '0a1b2c3d-0000-4000-8000-000000000002',
    name: 'Diego Siciliani',
    upn: 'diego.siciliani@example.com',
    status: crit,
    lastSignIn: ago(3 * 3_600_000),
    mfa: 1,
    licences: ['M365 E3', 'Visio P2'],
  },
  {
    id: '0a1b2c3d-0000-4000-8000-000000000003',
    name: 'Grady Archie',
    upn: 'grady.archie@example.com',
    status: off,
    lastSignIn: null,
    mfa: 0,
    licences: [],
  },
  {
    id: '0a1b2c3d-0000-4000-8000-000000000004',
    name: 'Isaiah Langer',
    upn: 'isaiah.langer@example.com',
    status: ok,
    lastSignIn: ago(2 * 86_400_000),
    mfa: 2,
    licences: ['M365 E3'],
  },
  {
    id: '0a1b2c3d-0000-4000-8000-000000000005',
    name: 'Johanna Lorenz',
    upn: 'johanna.lorenz@example.com',
    status: ok,
    lastSignIn: ago(20 * 60_000),
    mfa: 4,
    licences: ['M365 E5', 'Entra ID P2', 'Intune P1'],
  },
  {
    id: '0a1b2c3d-0000-4000-8000-000000000006',
    name: 'Lee Gu',
    upn: 'lee.gu@example.com',
    status: crit,
    lastSignIn: ago(40 * 86_400_000),
    mfa: 1,
    licences: ['M365 E3'],
  },
];

const COLUMNS: DataColumn<User>[] = [
  {
    id: 'name',
    header: 'Name',
    kind: 'identity',
    value: (u) => ({ primary: u.name, secondary: u.upn }),
    hideable: false,
  },
  { id: 'status', header: 'Status', kind: 'status', value: (u) => u.status },
  { id: 'lastSignIn', header: 'Last sign-in', kind: 'relativeTime', value: (u) => u.lastSignIn },
  { id: 'mfa', header: 'MFA methods', kind: 'number', value: (u) => u.mfa },
  { id: 'id', header: 'Object ID', kind: 'id', value: (u) => u.id },
  { id: 'licences', header: 'Licences', kind: 'tags', value: (u) => u.licences },
];

const bodyRows = () => {
  const grid = screen.getByRole('grid', { name: 'Users' });
  return within(grid).getAllByRole('row').slice(1);
};
/** The filter-bar facet button (the column header also has a sort button with the same name). */
const facetButton = (name: string) =>
  screen.getAllByRole('button', { name }).find((b) => !b.closest('[role="columnheader"]'))!;
const names = () =>
  bodyRows().map(
    (r) =>
      within(r)
        .getAllByRole('gridcell')
        .find((c) => c.textContent?.includes('@'))!
        .querySelector('span span')!.textContent,
  );

describe('DataTable', () => {
  it('renders a labelled grid with every kind of cell', async () => {
    const { container } = render(
      <DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />,
    );
    const grid = screen.getByRole('grid', { name: 'Users' });
    expect(grid).toHaveAttribute('aria-rowcount', '7');
    expect(grid).toHaveAttribute('aria-colcount', '6');
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Status', 'Last sign-in', 'MFA methods', 'Object ID', 'Licences']);
    expect(bodyRows()).toHaveLength(6);
    const adele = bodyRows()[0]!;
    expect(adele).toHaveTextContent('Adele Vance');
    expect(adele).toHaveTextContent('adele.vance@example.com');
    expect(within(adele).getByText('Enabled').closest('[data-status]')).toHaveAttribute('data-status', 'ok');
    expect(within(adele).getByText('5 min ago').tagName).toBe('TIME');
    expect(within(adele).getByText('0a1b…0001')).toHaveAttribute('title', USERS[0]!.id);
    // Blank time renders an em dash; tag lists cap at two plus a count.
    expect(within(bodyRows()[2]!).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(bodyRows()[4]!).getByText('+1')).toHaveAttribute('title', 'Intune P1');
    expect(screen.getByText('6 rows')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('sorts from the header and reports aria-sort; blanks stay last both ways', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />);
    const header = screen.getByRole('columnheader', { name: /Last sign-in/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    await user.click(within(header).getByRole('button', { name: 'Last sign-in' }));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(names()[0]).toBe('Lee Gu');
    expect(names().at(-1)).toBe('Grady Archie');
    await user.click(within(header).getByRole('button', { name: 'Last sign-in' }));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(names()[0]).toBe('Adele Vance');
    expect(names().at(-1)).toBe('Grady Archie');
  });

  it('sorts status by severity and numbers numerically', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        label="Users"
        data={USERS}
        columns={COLUMNS}
        getRowId={(u) => u.id}
        initialSort={[{ id: 'status', desc: true }]}
      />,
    );
    expect(screen.getByRole('columnheader', { name: /Status/ })).toHaveAttribute('aria-sort', 'descending');
    expect(names().slice(0, 2).sort()).toEqual(['Diego Siciliani', 'Lee Gu']);
    // Numbers sort high → low on the first click (TanStack's default for numeric columns).
    await user.click(screen.getByRole('button', { name: 'MFA methods' }));
    expect(screen.getByRole('columnheader', { name: /MFA methods/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(names()[0]).toBe('Johanna Lorenz');
    expect(names().at(-1)).toBe('Grady Archie');
  });

  it('global search filters rows and shows "N of M rows"', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        label="Users"
        data={USERS}
        columns={COLUMNS}
        getRowId={(u) => u.id}
        searchPlaceholder="Search name or UPN…"
      />,
    );
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'lorenz');
    expect(names()).toEqual(['Johanna Lorenz']);
    expect(screen.getByText('1 of 6 rows')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '2');
  });

  it('filters by facet through the filter bar and clears it from the chip', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />);
    await user.click(facetButton('Status'));
    const facet = await screen.findByRole('group', { name: 'Status' });
    expect(facet).toHaveTextContent('Compromised2');
    await user.click(within(facet).getByRole('checkbox', { name: 'Compromised' }));
    await user.keyboard('{Escape}');
    expect(names().sort()).toEqual(['Diego Siciliani', 'Lee Gu']);
    expect(screen.getByText('2 of 6 rows')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove filter Status: Compromised' }));
    expect(bodyRows()).toHaveLength(6);
  });

  it('filters a tags column by any selected value', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />);
    await user.click(facetButton('Licences'));
    const facet = await screen.findByRole('group', { name: 'Licences' });
    await user.click(within(facet).getByRole('checkbox', { name: 'Visio P2' }));
    await user.click(within(facet).getByRole('checkbox', { name: 'Intune P1' }));
    await user.keyboard('{Escape}');
    expect(names().sort()).toEqual(['Diego Siciliani', 'Johanna Lorenz']);
  });

  it('per-column text filter from the header', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />);
    await user.click(screen.getByRole('button', { name: 'Filter Name' }));
    await user.type(await screen.findByRole('textbox', { name: 'Name contains' }), 'gu');
    await user.keyboard('{Escape}');
    expect(names()).toEqual(['Lee Gu']);
    expect(screen.getByRole('button', { name: 'Remove filter Name: contains “gu”' })).toBeInTheDocument();
  });

  it('an open column filter has no axe violations', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />);
    await user.click(screen.getByRole('button', { name: 'Filter Status' }));
    await screen.findByRole('checkbox', { name: 'Compromised' });
    expect(await axeViolations()).toEqual([]);
  });

  it('the Columns menu hides and shows columns', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />);
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitemcheckbox', { name: 'Name' })).toBeNull();
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Object ID' }));
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Object ID' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.queryByRole('columnheader', { name: /Object ID/ })).toBeNull();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-colcount', '5');
  });

  it('hidden columns start hidden', () => {
    render(
      <DataTable
        label="Users"
        data={USERS}
        columns={COLUMNS.map((c) => (c.id === 'mfa' ? { ...c, hidden: true } : c))}
        getRowId={(u) => u.id}
      />,
    );
    expect(screen.queryByRole('columnheader', { name: /MFA methods/ })).toBeNull();
  });

  it('selects rows (and all rows) and shows the bulk-action bar with the selected rows', async () => {
    const user = userEvent.setup();
    const bulk = vi.fn((rows: User[]) => <Button size="sm">Disable {rows.length}</Button>);
    const { container } = render(
      <DataTable
        label="Users"
        data={USERS}
        columns={COLUMNS}
        getRowId={(u) => u.id}
        selectable
        rowLabel={(u) => u.name}
        bulkActions={bulk}
      />,
    );
    expect(screen.getByRole('grid')).toHaveAttribute('aria-multiselectable', 'true');
    await user.click(screen.getByRole('checkbox', { name: 'Select Adele Vance' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Lee Gu' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('2 selected');
    expect(
      bulk.mock.calls
        .at(-1)![0]
        .map((u: User) => u.name)
        .sort(),
    ).toEqual(['Adele Vance', 'Lee Gu']);
    expect(within(bar).getByRole('button', { name: 'Disable 2' })).toBeInTheDocument();
    expect(bodyRows()[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toHaveAttribute(
      'aria-checked',
      'mixed',
    );
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('6 selected');
    await user.click(
      within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', {
        name: 'Clear selection',
      }),
    );
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });

  it('Shift-click selects a range', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        label="Users"
        data={USERS}
        columns={COLUMNS}
        getRowId={(u) => u.id}
        selectable
        rowLabel={(u) => u.name}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select Adele Vance' }));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox', { name: 'Select Isaiah Langer' }));
    await user.keyboard('{/Shift}');
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('4 selected');
  });

  it('keyboard: rows are one tab stop; arrows move, Home/End jump, Enter activates, Space selects', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <DataTable
        label="Users"
        data={USERS}
        columns={COLUMNS}
        getRowId={(u) => u.id}
        selectable
        onRowActivate={onActivate}
        toolbar={false}
      />,
    );
    const rows = bodyRows();
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    rows[0]!.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(bodyRows()[1]).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledWith(USERS[1]);
    await user.keyboard(' ');
    expect(bodyRows()[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    await waitFor(() => expect(bodyRows()[5]).toHaveFocus());
    await user.keyboard('{Home}');
    await waitFor(() => expect(bodyRows()[0]).toHaveFocus());
    await user.keyboard('{ArrowUp}');
    expect(bodyRows()[0]).toHaveFocus();
  });

  it('clicking a row activates it, but clicking its checkbox does not', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <DataTable
        label="Users"
        data={USERS}
        columns={COLUMNS}
        getRowId={(u) => u.id}
        selectable
        rowLabel={(u) => u.name}
        onRowActivate={onActivate}
        activeRowId={USERS[2]!.id}
      />,
    );
    await user.click(screen.getByText('Diego Siciliani'));
    expect(onActivate).toHaveBeenCalledWith(USERS[1]);
    await user.click(screen.getByRole('checkbox', { name: 'Select Lee Gu' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(bodyRows()[2]!.className).toContain('af-row-active');
  });

  it('loading state is busy and shows skeleton rows', async () => {
    const { container } = render(
      <DataTable label="Users" data={[]} columns={COLUMNS} getRowId={(u: User) => u.id} loading />,
    );
    const grid = screen.getByRole('grid', { name: 'Users' });
    expect(grid).toHaveAttribute('aria-busy', 'true');
    expect(grid.querySelectorAll('.af-skeleton').length).toBeGreaterThan(0);
    expect(screen.getByText('Loading Users')).toHaveClass('sr-only');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('error state alerts with code and a retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = render(
      <DataTable
        label="Sign-in logs"
        data={[]}
        columns={COLUMNS}
        getRowId={(u: User) => u.id}
        error={{
          message: 'Microsoft Graph is throttling requests from this tenant.',
          hint: 'Try again in 30 seconds.',
          code: 'throttled',
          correlationId: '5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d',
          onRetry,
        }}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load sign-in logs");
    expect(within(alert).getByText('throttled')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('empty state uses the given title', async () => {
    const { container } = render(
      <DataTable
        label="Guests"
        data={[]}
        columns={COLUMNS}
        getRowId={(u: User) => u.id}
        empty={{ title: 'No guests in this tenant', description: 'Invite external people from Users.' }}
      />,
    );
    expect(screen.getByText('No guests in this tenant')).toBeInTheDocument();
    expect(screen.getByText('Invite external people from Users.')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('filtering to nothing offers Clear filters', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Users" data={USERS} columns={COLUMNS} getRowId={(u) => u.id} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'nobody-matches-this');
    expect(screen.getByText('No rows match these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(bodyRows()).toHaveLength(6);
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
  });
});
