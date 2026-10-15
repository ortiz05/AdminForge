import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WIDGETS, tableFixtures, type TableConfig, type TableViewState } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { failed, loading, ready, renderWidget, spyRuntime } from './helpers';

const Table = WIDGETS.table!.component;
const config = WIDGETS.table!.schema.parse(tableFixtures.users.config) as TableConfig;
const rows = tableFixtures.users.rows;
const users = () => ({ value: rows });

const grid = () => screen.getByRole('grid', { name: 'Results' });
const bodyRows = () => within(grid()).getAllByRole('row').slice(1);

describe('table widget', () => {
  it('renders typed columns, hidden columns stay hidden, and the provenance footer', async () => {
    const { container } = renderWidget(Table, config, ready(users().value));
    // The first header holds the select-all checkbox (selection: multi).
    expect(within(grid()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '',
      'Name',
      'Status',
      'Type',
      'Department',
      'Last sign-in',
      'Actions',
    ]);
    expect(bodyRows()).toHaveLength(5);
    const adele = bodyRows()[0]!;
    expect(adele).toHaveTextContent('Adele Vance');
    expect(adele).toHaveTextContent('adele.vance@example.com');
    expect(within(adele).getByText('Enabled').closest('[data-status]')).toHaveAttribute('data-status', 'ok');
    expect(within(bodyRows()[1]!).getByText('Disabled').closest('[data-status]')).toHaveAttribute('data-status', 'crit');
    // Blank values render an em dash.
    expect(within(bodyRows()[3]!).getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('5 rows')).toBeInTheDocument();
    expect(screen.getByText('graph')).toBeInTheDocument();
    expect(screen.getByText('/users')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('row actions follow their `when`: a disabled user has no “Disable sign-in”', async () => {
    const user = userEvent.setup();
    const { runtime, openPlaybook } = spyRuntime();
    renderWidget(Table, config, ready(rows), runtime);
    await user.click(screen.getByRole('button', { name: 'Actions for Diego Siciliani' }));
    const menu = await screen.findByRole('menu');
    await within(menu).findByRole('menuitem', { name: /Open in Entra admin center/ });
    expect(within(menu).queryByRole('menuitem', { name: 'Disable sign-in' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Actions for Adele Vance' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disable sign-in' }));
    await waitFor(() => expect(openPlaybook).toHaveBeenCalledWith({ playbook: 'identity.disable-user', inputs: { userId: rows[0]!.id } }));
  });

  it('an href row action opens external links in a new tab', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderWidget(Table, config, ready(rows));
    await user.click(screen.getByRole('button', { name: 'Actions for Adele Vance' }));
    await user.click(await screen.findByRole('menuitem', { name: /Open in Entra admin center/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(`https://entra.microsoft.com/#view/users/${rows[0]!.id}`, '_blank', 'noopener,noreferrer'));
    open.mockRestore();
  });

  it('bulk actions: one inputs object per selected row, shown only while their `when` holds', async () => {
    const user = userEvent.setup();
    const { runtime, openPlaybook } = spyRuntime();
    const { container } = renderWidget(Table, config, ready(rows), runtime);
    // Only a disabled user selected → "Disable sign-in" isn't offered.
    await user.click(screen.getByRole('checkbox', { name: 'Select Diego Siciliani' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('1 selected');
    await new Promise((r) => setTimeout(r, 30));
    expect(within(bar).queryByRole('button', { name: 'Disable sign-in' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Select Adele Vance' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Lee Gu' }));
    const button = await within(bar).findByRole('button', { name: 'Disable sign-in' });
    expect(await axeViolations(container)).toEqual([]);
    await user.click(button);
    await waitFor(() => expect(openPlaybook).toHaveBeenCalledTimes(1));
    const launch = openPlaybook.mock.calls[0]![0] as { playbook: string; items: Array<Record<string, unknown>> };
    expect(launch.playbook).toBe('identity.disable-user');
    expect(launch.items.map((i) => i.userId).sort()).toEqual([rows[0]!.id, rows[1]!.id, rows[4]!.id].sort());
  });

  it('bulk actions above maxItems are locked with an explanation', async () => {
    const user = userEvent.setup();
    const capped = WIDGETS.table!.schema.parse({
      ...tableFixtures.users.config,
      bulkActions: [{ ...tableFixtures.users.config.bulkActions[0]!, maxItems: 1 }],
    }) as TableConfig;
    renderWidget(Table, capped, ready(rows));
    await user.click(screen.getByRole('checkbox', { name: 'Select Adele Vance' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Lee Gu' }));
    const button = await screen.findByRole('button', { name: 'Disable sign-in' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('Select at most 1 rows for disable sign-in.');
  });

  it('clicking a row opens the inspector with rendered params; the inspected row is marked', async () => {
    const user = userEvent.setup();
    const { runtime, inspect } = spyRuntime({ inspecting: { page: 'identity.user', params: { id: rows[2]!.id } } });
    renderWidget(Table, config, ready(rows), runtime);
    expect(bodyRows()[2]).toHaveClass('af-row-active');
    await user.click(within(bodyRows()[1]!).getByText('HR'));
    await waitFor(() => expect(inspect).toHaveBeenCalledWith({ page: 'identity.user', params: { id: rows[1]!.id } }));
  });

  it('controlled view: sorting reports through setTableView with the table instance id', async () => {
    const user = userEvent.setup();
    let stored: TableViewState | undefined = { density: 'compact' };
    const setTableView = vi.fn((_id: string, v: TableViewState) => {
      stored = v;
    });
    const { runtime } = spyRuntime({ tableView: () => stored, setTableView });
    const { container } = renderWidget(Table, config, ready(rows), runtime, { instanceId: 'users' });
    expect(container.querySelector('[data-density="compact"]')).not.toBeNull();
    await user.click(within(grid()).getByRole('button', { name: 'Department' }));
    expect(setTableView).toHaveBeenCalledWith('users', expect.objectContaining({ sorting: [{ id: 'department', desc: false }], density: 'compact' }));
  });

  it('cursor paging: Load more in the footer, and duplicate rows across pages are dropped', async () => {
    const user = userEvent.setup();
    const loadMore = vi.fn();
    renderWidget(Table, config, ready([...rows, rows[0]!], { hasMore: true, loadMore }));
    expect(bodyRows()).toHaveLength(5);
    expect(screen.getByText('5 loaded · more available')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalled();
  });

  it('loading, error (with Try again) and empty states', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWidget(Table, config, loading);
    expect(grid()).toHaveAttribute('aria-busy', 'true');
    unmount();

    const err = failed();
    const second = renderWidget(Table, config, err);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Results didn’t load');
    expect(alert).toHaveTextContent('Microsoft Graph refused this request (403).');
    expect(alert).toHaveTextContent('Activate Global Reader in PIM');
    expect(alert).toHaveTextContent('forbidden');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(err.retry).toHaveBeenCalled();
    second.unmount();

    const { container } = renderWidget(Table, config, ready([]));
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
    expect(screen.getByText('Try different filters or a broader search.')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('content `empty` copy wins over the default', () => {
    const withEmpty = WIDGETS.table!.schema.parse({ ...tableFixtures.users.config, empty: { title: 'No guests yet', body: 'Invite one from Entra.' } }) as TableConfig;
    renderWidget(Table, withEmpty, ready([]));
    expect(screen.getByText('No guests yet')).toBeInTheDocument();
    expect(screen.getByText('Invite one from Entra.')).toBeInTheDocument();
  });

  it('tags columns accept arrays and objects (Azure tags) and boolean/percent/bytes cells format', () => {
    const typed = WIDGETS.table!.schema.parse({
      widget: 'table',
      data: 'r.value',
      rowKey: 'id',
      columns: [
        { field: 'name', label: 'Resource' },
        { field: 'tags', label: 'Tags', kind: 'tags' },
        { field: 'locked', label: 'Locked', kind: 'boolean' },
        { field: 'used', label: 'Used', kind: 'percent' },
        { field: 'size', label: 'Size', kind: 'bytes' },
      ],
    }) as TableConfig;
    renderWidget(Table, typed, ready([{ id: 'a', name: 'vm-01', tags: { env: 'prod' }, locked: false, used: 0.5, size: 1536 }]));
    const row = bodyRows()[0]!;
    expect(within(row).getByText('env: prod')).toBeInTheDocument();
    expect(within(row).getByText('No')).toBeInTheDocument();
    expect(within(row).getByText('50%')).toBeInTheDocument();
    expect(within(row).getByText('1.5 KB')).toBeInTheDocument();
  });
});
