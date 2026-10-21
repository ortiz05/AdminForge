import { fireEvent, render, screen, within } from '@testing-library/react';
import { DataTable, kpi, type DataColumn } from '@adminforge/ui';

// Truncation where it carries meaning (design review D-15): headers say what they cut off, time cells are never cut,
// fixed widths keep a floor per column kind, messages get two lines, KPI labels two lines.
interface Row {
  id: string;
  name: string;
  message: string;
  seen: string;
}
const ROWS: Row[] = [
  {
    id: 'a',
    name: 'Adele Vance',
    message: 'The sign-in was blocked by a Conditional Access policy that requires a compliant device.',
    seen: new Date(Date.now() - 13_000).toISOString(),
  },
];
const COLUMNS: DataColumn<Row>[] = [
  { id: 'name', header: 'Last interactive sign-in location', kind: 'text', value: (r) => r.name },
  { id: 'message', header: 'Message', kind: 'text', lines: 2, value: (r) => r.message },
  { id: 'seen', header: 'Seen', kind: 'relativeTime', value: (r) => r.seen, width: '60px' },
];

const renderTable = (columns = COLUMNS) =>
  render(<DataTable label="Sign-ins" data={ROWS} columns={columns} getRowId={(r) => r.id} />);

/** The grid tracks the table lays its columns out with. */
const tracks = (container: HTMLElement) =>
  (container.firstElementChild as HTMLElement).style.getPropertyValue('--af-dt-cols');

/** jsdom has no layout: make an element report that its text overflows (or not). */
function overflow(el: HTMLElement, clipped: boolean) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: clipped ? 200 : 80 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 80 });
}

describe('DataTable truncation', () => {
  it('a clipped header gets its full text as a tooltip; one that fits gets none', () => {
    renderTable();
    const header = screen.getByRole('columnheader', { name: /Last interactive/ });
    const text = within(header).getByText('Last interactive sign-in location');
    overflow(text, true);
    fireEvent.pointerOver(text);
    expect(text).toHaveAttribute('title', 'Last interactive sign-in location');
    overflow(text, false);
    fireEvent.pointerOver(header);
    expect(text).not.toHaveAttribute('title');
  });

  it('clipped cell text gets a tooltip too', () => {
    renderTable();
    const cell = screen.getByText('Adele Vance');
    overflow(cell, true);
    fireEvent.pointerOver(cell);
    expect(cell).toHaveAttribute('title', 'Adele Vance');
  });

  it('time cells never truncate and a fixed width keeps the floor for its kind', () => {
    const { container } = renderTable();
    const time = screen.getByText('13 s ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveClass('whitespace-nowrap');
    expect(time).not.toHaveClass('truncate');
    // "60px" asked for; a relative time needs 112.
    expect(tracks(container)).toBe('minmax(140px, 1fr) minmax(140px, 1fr) 112px');
  });

  it('a wider fixed width, a column floor of its own and grid expressions are kept as given', () => {
    const { container } = renderTable([
      { id: 'a', header: 'A', kind: 'relativeTime', width: '140px', value: (r) => r.seen },
      { id: 'b', header: 'B', kind: 'relativeTime', width: '60px', minWidth: 150, value: (r) => r.seen },
      { id: 'c', header: 'C', kind: 'text', width: 'minmax(100px, 1fr)', value: (r) => r.name },
      { id: 'd', header: 'D', kind: 'enum', value: (r) => r.name },
    ]);
    expect(tracks(container)).toBe('140px 150px minmax(100px, 1fr) minmax(120px, 0.8fr)');
  });

  it('message columns wrap to two lines (one in compact density) before the ellipsis', () => {
    renderTable();
    const msg = screen.getByText(/blocked by a Conditional Access policy/);
    expect(msg).toHaveClass('line-clamp-2', 'compact:line-clamp-1', 'whitespace-normal');
    expect(msg).not.toHaveClass('truncate');
  });

  it('KPI labels get two lines', () => {
    expect(kpi().label()).toContain('line-clamp-2');
    expect(kpi().label()).not.toContain('truncate');
  });
});
