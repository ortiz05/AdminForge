import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WIDGETS, type TableConfig } from '@adminforge/widgets';
import { ready, renderWidget, spyRuntime } from './helpers';

// A table row action's href is templated from the row. It follows the one rule for links from data (`followSafeUrl`
// in @adminforge/ui, via the widgets' followHref) like content actions and the app's navigation: in-app through the
// router, external in a new tab without opener, anything else not at all. The table kept a copy of that rule; it now
// calls followHref.

const Table = WIDGETS.table!.component;
const config = WIDGETS.table!.schema.parse({
  widget: 'table',
  id: 'items',
  data: 'items',
  rowKey: 'id',
  columns: [{ field: 'name', label: 'Name' }],
  rowActions: [{ label: 'Open', href: '${ row.target }' }],
}) as TableConfig;

const ROWS = [
  { id: '1', name: 'In app', target: '/p/identity.users?userType=Guest' },
  { id: '2', name: 'External', target: 'https://learn.microsoft.com/' },
  { id: '3', name: 'Other site', target: '//evil.example.com' },
  { id: '4', name: 'Backslash host', target: '/\\evil.example.com' },
  { id: '5', name: 'Script', target: 'javascript:alert(1)' },
];

afterEach(() => vi.restoreAllMocks());

async function openFor(name: string) {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const { runtime, navigate } = spyRuntime();
  renderWidget(Table, config, ready(ROWS), runtime);
  await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: 'Open' }));
  // The href is evaluated asynchronously: let it settle.
  await new Promise((r) => setTimeout(r, 30));
  return { open, navigate };
}

describe('table row action hrefs', () => {
  it('an in-app target goes through the router', async () => {
    const { open, navigate } = await openFor('In app');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/p/identity.users?userType=Guest'));
    expect(open).not.toHaveBeenCalled();
  });

  it('an external target opens a new tab without opener', async () => {
    const { open, navigate } = await openFor('External');
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://learn.microsoft.com/', '_blank', 'noopener,noreferrer'),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['Other site', 'Backslash host', 'Script'])(
    '%s: neither navigates nor opens a window',
    async (name) => {
      const { open, navigate } = await openFor(name);
      expect(navigate).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );
});
