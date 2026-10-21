import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableColumn } from '@adminforge/schemas';
import { WIDGETS, type TableConfig } from '@adminforge/widgets';
import { ready, renderWidget } from './helpers';

// Plain categories (a join type, a source, a group type) are `enum` columns: the label as text, a facet filter, no
// status pill with a meaningless dot; `status` stays for values that say whether something is fine (design review
// D-16).
const Table = WIDGETS.table!.component;
const config = WIDGETS.table!.schema.parse({
  widget: 'table',
  id: 'devices',
  data: 'devices.value',
  columns: [
    { field: 'displayName', label: 'Name', kind: 'identity' },
    {
      field: 'trustType',
      label: 'Join type',
      kind: 'enum',
      map: { AzureAd: 'Entra joined', ServerAd: 'Hybrid joined', Workplace: 'Registered' },
    },
    { field: 'source', label: 'Source', kind: 'enum' },
    {
      field: 'isCompliant',
      label: 'Compliant',
      kind: 'status',
      map: { true: ['ok', 'Compliant'], false: ['crit', 'Not compliant'] },
    },
  ],
}) as TableConfig;
const rows = [
  { id: '1', displayName: 'AVERY-LAPTOP', trustType: 'AzureAd', source: 'Intune', isCompliant: true },
  { id: '2', displayName: 'BLAKE-DESKTOP', trustType: 'serverad', source: 'Autopilot', isCompliant: false },
  { id: '3', displayName: 'CASEY-PHONE', trustType: 'Unknown', source: null, isCompliant: true },
];

const grid = () => screen.getByRole('grid', { name: 'Results' });
const bodyRows = () => within(grid()).getAllByRole('row').slice(1);

describe('table enum columns', () => {
  it('render the label as plain text — mapped (case-insensitively), else the raw value — with no status pill', () => {
    renderWidget(Table, config, ready(rows));
    const [avery, blake, casey] = bodyRows();
    const entra = within(avery!).getByText('Entra joined');
    expect(entra.closest('[data-status]')).toBeNull();
    expect(within(blake!).getByText('Hybrid joined')).toBeInTheDocument();
    expect(within(casey!).getByText('Unknown')).toBeInTheDocument();
    expect(within(avery!).getByText('Intune').closest('[data-status]')).toBeNull();
    // A missing value is an em dash, as everywhere.
    expect(within(casey!).getAllByText('—').length).toBeGreaterThan(0);
    // Status columns keep their tone.
    expect(within(blake!).getByText('Not compliant').closest('[data-status]')).toHaveAttribute(
      'data-status',
      'crit',
    );
  });

  it('are filtered by facet by default, with the labels as options', async () => {
    const user = userEvent.setup();
    renderWidget(Table, config, ready(rows));
    await user.click(screen.getByRole('button', { name: 'Filter Join type' }));
    const dialog = await screen.findByRole('dialog', { name: 'Filter Join type' });
    for (const label of ['Entra joined', 'Hybrid joined', 'Unknown'])
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    await user.click(within(dialog).getByText('Hybrid joined'));
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('BLAKE-DESKTOP');
  });

  it('the schema keeps tones and plain labels apart', () => {
    const tone = TableColumn.safeParse({
      field: 'trustType',
      label: 'Join type',
      kind: 'enum',
      map: { AzureAd: ['info', 'Entra joined'] },
    });
    expect(tone.success).toBe(false);
    expect(tone.error!.issues[0]).toMatchObject({ path: ['map', 'AzureAd'] });
    expect(tone.error!.issues[0]!.message).toMatch(/Tones belong to kind: status/);

    const label = TableColumn.safeParse({
      field: 'accountEnabled',
      label: 'Status',
      kind: 'status',
      map: { true: 'Enabled' },
    });
    expect(label.success).toBe(false);
    expect(label.error!.issues[0]!.message).toMatch(/use kind: enum/);
  });
});
