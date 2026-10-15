import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, type DataColumn } from '@adminforge/ui';

// `selection: single`: one row at a time (no "select all"), for actions that act on exactly one item.
interface Row {
  id: string;
  name: string;
}
const ROWS: Row[] = [
  { id: 'a', name: 'Adele Vance' },
  { id: 'b', name: 'Lee Gu' },
];
const COLUMNS: DataColumn<Row>[] = [{ id: 'name', header: 'Name', kind: 'text', value: (r) => r.name }];

describe('DataTable single selection', () => {
  it('selecting a row replaces the previous one and there is no select-all', async () => {
    const bulk = vi.fn((rows: Row[]) => <span>{rows.map((r) => r.name).join(', ')}</span>);
    render(
      <DataTable
        label="People"
        data={ROWS}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        selectable="single"
        rowLabel={(r) => r.name}
        bulkActions={bulk}
      />,
    );
    expect(screen.queryByRole('checkbox', { name: 'Select all rows' })).toBeNull();
    expect(screen.getByRole('grid')).not.toHaveAttribute('aria-multiselectable');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Adele Vance' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Lee Gu' }));
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('1 selected');
    expect(screen.getByRole('checkbox', { name: 'Select Adele Vance' })).not.toBeChecked();
  });
});
