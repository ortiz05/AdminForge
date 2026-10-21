import { render, screen, within } from '@testing-library/react';
import { WIDGETS, createWidgetRuntime, type KpiConfig } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready } from './helpers';

// Design review M3 and L11 (2026-10-21). In a KPI strip every cell is as tall as the row and its number sits at the
// foot (`mt-auto`), so numbers line up across cells. A drill-down cell is a link around the figure: the figure has to
// fill the link too, or a band of the strip's hairline colour shows under a shorter cell and its number rides high.
// A cell that couldn't be shown keeps the same order — label, then its reference and Try again, then "—" and the
// status at the foot — so its dash lines up with the other numbers, and its reference chip fits a narrow cell.

const Kpi = WIDGETS.kpi!.component;
const parse = (c: Record<string, unknown>) => WIDGETS.kpi!.schema.parse({ widget: 'kpi', ...c }) as KpiConfig;

describe('KPI cells in a strip', () => {
  it('a drill-down cell fills its link, so its number sits at the foot like the others', () => {
    render(
      <Kpi
        config={parse({ label: 'Active incidents', data: 'x', href: '/p/m365.incidents' })}
        data={ready(1)}
        runtime={createWidgetRuntime()}
        instanceId="k0"
        variant="cell"
      />,
    );
    const link = screen.getByRole('link', { name: /Active incidents/ });
    const figure = within(link).getByRole('group', { name: 'Active incidents' });
    expect(link).toHaveClass('h-full');
    expect(figure).toHaveClass('h-full');
  });

  it('a plain cell fills its grid area too', () => {
    render(
      <Kpi
        config={parse({ label: 'Guests', data: 'x' })}
        data={ready(4)}
        runtime={createWidgetRuntime()}
        instanceId="k0"
        variant="cell"
      />,
    );
    expect(screen.getByRole('group', { name: 'Guests' })).toHaveClass('h-full');
  });

  it('a cell that fails: label, reference and Try again, then the dash and the status at the foot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = createWidgetRuntime({
      resolve: () => {
        throw new Error('boom');
      },
    });
    const { container } = render(
      <Kpi
        config={parse({ label: 'Guests', data: 'x', delta: 'counts.delta' })}
        data={ready(12)}
        runtime={runtime}
        instanceId="k0"
        variant="cell"
      />,
    );
    const figure = screen.getByRole('group', { name: 'Guests' });
    expect(figure).toHaveClass('h-full');
    const copy = within(figure).getByRole('button', { name: /^Copy Reference / });
    const retry = within(figure).getByRole('button', { name: 'Try again' });
    const dash = within(figure).getByText('—');
    // Document order: the reference row comes before the number, which keeps its place at the foot.
    expect(copy.compareDocumentPosition(dash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(retry.compareDocumentPosition(dash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(figure).toHaveTextContent('Couldn’t be shown');
    // L11: in a cell the chip shows the value only (its button still names the reference), so it fits on one line.
    expect(within(figure).queryByText('Reference')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
    vi.restoreAllMocks();
  });
});
