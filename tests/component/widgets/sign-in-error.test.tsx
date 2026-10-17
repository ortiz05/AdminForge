import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WIDGETS,
  listFixtures,
  tableFixtures,
  type ListConfig,
  type TableConfig,
  type WidgetData,
} from '@adminforge/widgets';
import { renderWidget, spyRuntime } from './helpers';

// A `reauth` error (Microsoft wants a fresh sign-in) isn't fixed by "Try again": the widget offers "Sign in again" —
// or, when the page already shows its one sign-in banner, a quiet note instead of repeating the error.
const List = WIDGETS.list!.component;
const listConfig = WIDGETS.list!.schema.parse(listFixtures.incidents.config) as ListConfig;
const Table = WIDGETS.table!.component;
const tableConfig = {
  ...(WIDGETS.table!.schema.parse(tableFixtures.users.config) as TableConfig),
  title: 'Members',
};

const reauth = (retry = vi.fn()): WidgetData => ({
  status: 'error',
  value: undefined,
  error: {
    code: 'reauth',
    message: 'Microsoft needs you to sign in again.',
    hint: 'Sign in again to continue.',
    correlationId: '5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d',
    login: '/auth/login?returnTo=%2F',
  },
  retry,
});

describe('widget panel: reauth', () => {
  it('offers "Sign in again" (not "Try again") and starts the sign-in with the error’s login URL', async () => {
    const signIn = vi.fn();
    const { runtime } = spyRuntime({ signIn });
    renderWidget(List, listConfig, reauth(), runtime);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signIn).toHaveBeenCalledWith('/auth/login?returnTo=%2F');
  });

  it('under the page’s sign-in banner: a quiet note, no error and no buttons', () => {
    const { runtime } = spyRuntime({ signIn: vi.fn(), signInBanner: true });
    renderWidget(List, listConfig, reauth(), runtime);
    expect(screen.getByText(/^Sign in again to see /)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('other errors keep "Try again"', async () => {
    const retry = vi.fn();
    const { runtime } = spyRuntime({ signIn: vi.fn() });
    renderWidget(
      List,
      listConfig,
      { ...reauth(retry), error: { code: 'forbidden', message: 'Refused.' } },
      runtime,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
});

describe('table: reauth', () => {
  it('offers "Sign in again" instead of "Try again"', async () => {
    const signIn = vi.fn();
    const { runtime } = spyRuntime({ signIn });
    renderWidget(Table, tableConfig, reauth(), runtime);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signIn).toHaveBeenCalledWith('/auth/login?returnTo=%2F');
  });

  it('under the page’s sign-in banner: a quiet note in the table body', () => {
    const { runtime } = spyRuntime({ signIn: vi.fn(), signInBanner: true });
    renderWidget(Table, tableConfig, reauth(), runtime);
    expect(screen.getByText('Sign in again to see members')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /again/ })).toBeNull();
  });
});
