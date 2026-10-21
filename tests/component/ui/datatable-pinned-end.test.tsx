import { fireEvent, render, screen, within } from '@testing-library/react';
import { DataTable, type DataColumn } from '@adminforge/ui';
import { axeViolations } from '../axe';

// Design review L17 (2026-10-21). At 1440 px the Users list needed more room than it had, so its columns scrolled
// sideways and the row actions (the last, pinned column) were off-screen. A column pinned to the end now stays in view
// at the table's right edge while the others scroll under it — with a hairline once they do — and long headers wrap
// to two lines before they are cut off, keeping their full text as a tooltip.

interface Row {
  id: string;
  name: string;
  seen: string;
}
const ROWS: Row[] = [
  { id: 'a', name: 'Adele Vance', seen: '2026-10-20T08:00:00Z' },
  { id: 'b', name: 'Blake Example', seen: '2026-10-19T08:00:00Z' },
];
const COLUMNS: DataColumn<Row>[] = [
  { id: 'name', header: 'Name', kind: 'identity', value: (r) => ({ primary: r.name }) },
  { id: 'seen', header: 'Last interactive sign-in', kind: 'relativeTime', value: (r) => r.seen },
  {
    id: '__actions',
    header: 'Actions',
    headerHidden: true,
    pin: 'end',
    sortable: false,
    filter: 'none',
    hideable: false,
    width: '52px',
    value: () => null,
    cell: (r) => (
      <button type="button" aria-label={`Actions for ${r.name}`}>
        ⋮
      </button>
    ),
  },
];

const renderTable = () =>
  render(<DataTable label="Users" data={ROWS} columns={COLUMNS} getRowId={(r) => r.id} />);

/** jsdom has no layout: make every element report a width (and so whether the table scrolls sideways). */
function stubWidths(scroll: number, client: number) {
  const proto = HTMLElement.prototype;
  const saved = {
    scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
  };
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => client });
  return () => {
    for (const [k, d] of Object.entries(saved))
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
  };
}

const pinnedCells = () => [
  screen.getByRole('columnheader', { name: 'Actions' }),
  ...screen.getAllByRole('button', { name: /^Actions for / }).map((b) => b.closest('[role="gridcell"]')!),
];

describe('DataTable: the end-pinned column and long headers', () => {
  it('keeps the end-pinned column at the right edge, on the row’s own surface', async () => {
    const { container } = renderTable();
    for (const cell of pinnedCells()) expect(cell).toHaveClass('sticky', 'right-0');
    // Body cells take the row's surface (hover, selected), so the columns scrolling under them never show through.
    const body = screen.getAllByRole('button', { name: /^Actions for / })[0]!.closest('[role="gridcell"]')!;
    expect(body).toHaveClass('bg-inherit');
    expect(body.closest('[role="row"]')).toHaveClass('bg-panel');
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toHaveClass('bg-panel');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('draws a hairline on its edge only while the other columns scroll under it', () => {
    const restore = stubWidths(1268, 1134);
    try {
      renderTable();
      for (const cell of pinnedCells()) expect(cell).toHaveClass('border-l');
    } finally {
      restore();
    }
    const restoreFits = stubWidths(900, 1134);
    try {
      const { unmount } = renderTable();
      // The previous render is still mounted in the document; look at the newest table only.
      const grids = screen.getAllByRole('grid', { name: 'Users' });
      const last = grids[grids.length - 1]!;
      expect(within(last).getByRole('columnheader', { name: 'Actions' })).not.toHaveClass('border-l');
      unmount();
    } finally {
      restoreFits();
    }
  });

  it('a long header wraps to two lines before it is cut off, and shows its full text when it is', () => {
    renderTable();
    const header = screen.getByRole('columnheader', { name: /Last interactive sign-in/ });
    const text = within(header).getByText('Last interactive sign-in');
    expect(text).toHaveClass('line-clamp-2');
    expect(text).not.toHaveClass('truncate');
    Object.defineProperty(text, 'scrollHeight', { configurable: true, value: 45 });
    Object.defineProperty(text, 'clientHeight', { configurable: true, value: 30 });
    fireEvent.pointerOver(text);
    expect(text).toHaveAttribute('title', 'Last interactive sign-in');
  });
});
