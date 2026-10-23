import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { schedules } from '../../../support/web/fixtures/automation';
import { me } from '../../../support/web/fixtures/session';
import { axeViolations } from '../../axe';
import { renderApp } from './render';

// An Operator chooses the account a content schedule runs as on its page (docs/plans/2026-10-23-run-as-and-vault.md):
// the page says where the account comes from, saves the choice, and shows the API's refusal (an identity without the
// permissions the schedule declares) without changing anything.
const base = schedules().items.find((s) => s.key === 'reports.app-credential-expiry')!;
const OPERATOR = me({ roles: ['Portal.Reader', 'Portal.Operator'] });
const item = (runsAs: Record<string, unknown>) => ({ ...base, source: 'content', runsAs });
const DEFAULT = { kind: 'app', name: 'reports-team', label: 'app identity reports-team', source: 'default' };

function render(opts: { refuse?: boolean; roles?: string[] } = {}) {
  let current = item(DEFAULT);
  const puts: unknown[] = [];
  const view = renderApp({
    path: '/schedules/reports.app-credential-expiry',
    session: opts.roles ? me({ roles: opts.roles }) : OPERATOR,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === '/api/schedules' ? { body: { items: [current] } } : undefined,
      ({ method, path }) =>
        method === 'GET' && path === '/api/schedules/identities'
          ? { body: { apps: ['reports-team', 'ops-team'], user: false } }
          : undefined,
      ({ method, path, body }) => {
        if (method !== 'PUT' || path !== '/api/schedules/reports.app-credential-expiry/run-as')
          return undefined;
        puts.push(body);
        if (opts.refuse)
          return {
            status: 409,
            body: {
              error: {
                code: 'identity_lacks_permissions',
                message:
                  'The app identity ops-team lacks permissions this schedule needs: Application.Read.All (graph).',
                hint: 'Name the identity on the schedule in content, then run adminforge provision entra.',
                reference: 'ref-1',
              },
            },
          };
        current = item({
          kind: 'app',
          name: 'ops-team',
          label: 'app identity ops-team',
          source: 'override',
          setBy: 'operator@example.com',
          setAt: '2026-10-23T09:00:00.000Z',
        });
        return { body: current };
      },
    ],
  });
  return { ...view, puts };
}

describe('Schedule page: Run as', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says where the account comes from and saves another one', async () => {
    const { puts } = render();
    expect(
      await screen.findByText('The installation’s default for this kind of schedule.'),
    ).toBeInTheDocument();
    const save = await screen.findByRole('button', { name: 'Save account' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('combobox', { name: 'Run as' }));
    await userEvent.click(await screen.findByRole('option', { name: 'App identity ops-team' }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(puts).toEqual([{ identity: 'app:ops-team' }]));
    expect(await screen.findByText(/^Chosen here by operator@example\.com, /)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows why an identity was refused and keeps the account', async () => {
    render({ refuse: true });
    await userEvent.click(await screen.findByRole('combobox', { name: 'Run as' }));
    await userEvent.click(await screen.findByRole('option', { name: 'App identity ops-team' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save account' }));
    const toast = await screen.findByText('The account didn’t change');
    expect(toast.closest('[role="status"], [role="alert"], li') ?? document.body).toHaveTextContent(
      'lacks permissions this schedule needs: Application.Read.All (graph)',
    );
    expect(screen.getByText('The installation’s default for this kind of schedule.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('combobox', { name: 'Run as' })).getByText(/^Default/),
    ).toBeInTheDocument();
  });

  it('is not offered to a Reader', async () => {
    render({ roles: ['Portal.Reader'] });
    expect(
      await screen.findByText('The installation’s default for this kind of schedule.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Run as' })).toBeNull();
  });
});
