import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionButton, type PlaybookWriteState } from '@adminforge/widgets';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';
import { PERSON_PAGE, RESULTS, guid } from '../web/renderer-fixtures';
import { renderPage } from '../web/render-page';
import { spyRuntime } from './helpers';

/** Waiting budget for whole-page queries (the default 1 s is too short under load). */
const SLOW = { timeout: 8_000 };

// D-18 (platform review 2026-10-21): a content action that runs a write playbook looks like coded screens'
// WriteAction — a lock glyph and "Arm write access to run this" while unarmed, the small ember dot once armed — but
// stays clickable: the drawer's preview (dry run) works without write access. Ember never shows unarmed.
const HINT = 'Arm write access to run this; previewing it doesn’t need it.';
const action = { label: 'Block sign-in', playbook: 'identity.disable-user', inputs: { userId: 'u1' } };

function renderAction(write: PlaybookWriteState | undefined) {
  const { runtime, openPlaybook } = spyRuntime({ usePlaybookWrite: () => write });
  const view = render(<ActionButton action={action} scope={runtime.scope} runtime={runtime} />);
  return { ...view, openPlaybook, button: screen.getByRole('button', { name: 'Block sign-in' }) };
}

describe('ActionButton and write playbooks', () => {
  it('unarmed: lock glyph and the hint, but it still opens the playbook (to preview it)', async () => {
    const { button, openPlaybook, container } = renderAction({ armed: false, hint: HINT });
    expect(button.querySelector('[data-write-lock]')).not.toBeNull();
    expect(button).toHaveAccessibleDescription(HINT);
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(container.querySelector('.af-armed-dot')).toBeNull();
    expect(button.className).not.toMatch(/armed/);
    await userEvent.click(button);
    await waitFor(() =>
      expect(openPlaybook).toHaveBeenCalledWith({
        playbook: 'identity.disable-user',
        inputs: { userId: 'u1' },
      }),
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('armed: no lock, the ember dot', async () => {
    const { button, container } = renderAction({ armed: true });
    expect(button.querySelector('[data-write-lock]')).toBeNull();
    expect(button).not.toHaveAccessibleDescription(HINT);
    expect(container.querySelector('.af-armed-dot')).not.toBeNull();
  });

  it('a read playbook, or a runtime that knows nothing about write access, is a plain button', () => {
    const { button, container } = renderAction(undefined);
    expect(button.querySelector('[data-write-lock]')).toBeNull();
    expect(container.querySelector('.af-armed-dot')).toBeNull();
  });
});

// The page runtime reads the playbook's published `mode` (the drawer's cached definition) and the shell's arm state.
const playbook = (key: string, mode: 'read' | 'write') => ({
  kind: 'playbook',
  id: key,
  version: '1.0.0',
  sha256: 'p',
  title: key,
  owner: 'test',
  risk: mode === 'write' ? 'medium' : 'low',
  mode,
  inputs: { userId: { type: 'string', required: true } },
  steps: [
    { id: 'me', type: 'graph', mode, request: { method: mode === 'write' ? 'PATCH' : 'GET', path: '/me' } },
  ],
});
const definitions = {
  'page/test.person': PERSON_PAGE,
  'playbook/identity.disable-user': playbook('identity.disable-user', 'write'),
  'playbook/identity.revoke-sessions': playbook('identity.revoke-sessions', 'read'),
  'playbook/identity.reset-password': playbook('identity.reset-password', 'write'),
  'playbook/identity.reset-mfa': playbook('identity.reset-mfa', 'write'),
  'playbook/identity.issue-tap': playbook('identity.issue-tap', 'write'),
};
const PATH = `/p/test.person?id=${guid(1)}`;
const button = (name: string | RegExp) =>
  within(screen.getByRole('group', { name: 'Actions' })).getByRole('button', { name });

// A whole page in jsdom: data arrives late and role queries over the shell are slow (more so on a busy machine), so these get a larger budget.
describe('entity page actions and write access', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('locks write actions with the hint while unarmed; read actions stay plain; clicking opens the drawer', async () => {
    const { router } = renderPage(PATH, { definitions, results: RESULTS });
    // The header re-renders as data arrives ("Block sign-in" waits for the profile, its `when`): query afresh.
    await waitFor(() => expect(button('Block sign-in')).toHaveAccessibleDescription(HINT), SLOW);
    expect(button('Block sign-in').querySelector('[data-write-lock]')).not.toBeNull();
    expect(button('Revoke sessions').querySelector('[data-write-lock]')).toBeNull();
    expect(button('Revoke sessions')).not.toHaveAccessibleDescription(HINT);
    // More actions: write items show the lock too.
    await userEvent.click(button(/More actions/));
    const item = await screen.findByRole('menuitem', { name: /Issue Temporary Access Pass/ }, SLOW);
    expect(item.querySelector('[data-write-lock]')).not.toBeNull();
    expect(item).toHaveAccessibleDescription(HINT);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(button('Block sign-in'));
    await waitFor(
      () => expect(router.state.location.search).toMatchObject({ playbook: 'identity.disable-user' }),
      SLOW,
    );
  });

  it('names the role instead when the person cannot arm', async () => {
    renderPage(PATH, {
      definitions,
      results: RESULTS,
      session: me({ roles: ['Portal.Reader'], canArm: false }),
    });
    await waitFor(
      () =>
        expect(button('Block sign-in')).toHaveAccessibleDescription(
          'Running this needs the Portal Operator role; previewing it doesn’t.',
        ),
      SLOW,
    );
  });

  it('armed: no lock, the ember dot on write actions only', async () => {
    // Armed for the next half hour of the real clock (armedMe() is pinned to the e2e clock).
    const armed = me({ mode: 'armed', armedUntil: new Date(Date.now() + 30 * 60_000).toISOString() });
    renderPage(PATH, { definitions, results: RESULTS, session: armed });
    await waitFor(() => expect(button('Block sign-in').querySelector('.af-armed-dot')).not.toBeNull(), SLOW);
    expect(button('Block sign-in').querySelector('[data-write-lock]')).toBeNull();
    expect(button('Revoke sessions').querySelector('.af-armed-dot')).toBeNull();
  });
});
