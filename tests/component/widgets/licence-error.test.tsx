import { screen } from '@testing-library/react';
import { WIDGETS, listFixtures, type ListConfig } from '@adminforge/widgets';
import { renderWidget } from './helpers';

// A missing licence isn't a failure: the panel explains it neutrally (no red error, no "Try again").
const List = WIDGETS.list!.component;
const config = WIDGETS.list!.schema.parse(listFixtures.incidents.config) as ListConfig;

describe('widget panel: licence_required', () => {
  it('shows a neutral licence notice with the requirement, without retry', () => {
    renderWidget(List, config, {
      status: 'error',
      value: undefined,
      error: { code: 'licence_required', message: 'Requires Microsoft Entra ID P2.' },
      retry: vi.fn(),
    });
    expect(screen.getByText(/needs a licence your tenant doesn’t have/)).toBeInTheDocument();
    expect(screen.getByText(/Requires Microsoft Entra ID P2\./)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
