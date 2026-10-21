import { readFileSync } from 'node:fs';
import path from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parse } from 'yaml';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { playbookHref } from '@adminforge/web/src/playbooks/url';
import { repoRoot } from '../../../lib/repo';
import { at, IDS, previewDetail } from '../../../support/web/fixtures/automation';
import { armedMe, FIXED_NOW } from '../../../support/web/fixtures/session';
import type { MockHandler } from '../../../support/web/mock-handler';
import { axeViolations } from '../../axe';
import { renderApp } from '../automation/render';

// The playbook confirm dialog printed the definition's `confirm.message` — for most write playbooks a `${ … }`
// template. It now shows what the API rendered from the preview (`run.confirm`), evaluates nothing itself, compares a
// typed confirmation the way the API does, and points out characters in the text that aren't plain letters.

/** The published playbook, from portal/content (what the API would return). */
const content = (file: string) => ({
  ...(parse(readFileSync(path.join(repoRoot, 'portal/content/playbooks', file), 'utf8')) as object),
  sha256: 'a'.repeat(64),
});
const revokeGrant = content('identity/revoke-consent-grant.playbook.yaml');
const revokeSessions = content('identity/revoke-sessions.playbook.yaml');

/** An attacker-named app: a zero-width space and a Cyrillic letter e (U+0435) (escapes: nothing hidden in this source). */
const SHADY = 'PDF\u{200b} Convert\u{435}r';
const PREVIEW = 'a9d0c4f2-1111-4b6e-9c3a-5e7f9a1b3c5d';
const GRANT_INPUTS = { grantId: 'grant-shady', reason: 'Consent phishing reported in SEC-311' };
const SESSION_INPUTS = { userId: IDS.aLee, reason: 'INC-4821 account compromised' };

type Confirm = { type: 'typed' | 'click'; value: string | null; message: string | null };

/** The dry run of `def` with `inputs`, carrying the confirmation the API rendered. */
function preview(def: { id: string; title?: string }, inputs: Record<string, unknown>, confirm: Confirm) {
  const base = previewDetail(inputs, { id: PREVIEW, endedAgoMs: 30_000 });
  return {
    ...base,
    run: { ...base.run, definitionKey: def.id, title: def.title, confirm },
    steps: base.steps.slice(0, 1),
    plan: [
      {
        stepId: 'revoke',
        stepPath: 'revoke',
        describe: `Delete the user consent grant of ${SHADY} to Microsoft Graph (Mail.Read)`,
        service: 'graph',
        method: 'DELETE',
        path: '/oauth2PermissionGrants/grant-shady',
        at: at(-30_000),
      },
    ],
  };
}

function api(def: { id: string }, inputs: Record<string, unknown>, confirm: Confirm) {
  const posts: Array<Record<string, unknown>> = [];
  const handler: MockHandler = ({ method, path: p, body }) => {
    if (method === 'GET' && p === `/api/definitions/playbook/${def.id}`) return { body: def };
    if (method === 'GET' && p === `/api/runs/${PREVIEW}`) return { body: preview(def, inputs, confirm) };
    if (method === 'POST' && p === '/api/runs') {
      const b = body as Record<string, unknown>;
      if (b.playbook !== def.id) return undefined;
      posts.push(b);
      return { status: 202, body: { runId: b.dryRun ? PREVIEW : IDS.liveRun, status: 'queued' } };
    }
    return undefined;
  };
  return { handler, posts };
}

async function openConfirm(
  def: { id: string; title: string },
  inputs: Record<string, unknown>,
  confirm: Confirm,
) {
  const mock = api(def, inputs, confirm);
  renderApp({
    session: armedMe(),
    handlers: [mock.handler],
    path: playbookHref({ playbook: def.id, inputs }, '/'),
  });
  const drawer = await screen.findByRole('dialog', { name: def.title });
  // Before any preview: the risk banner never shows a template.
  expect(drawer.textContent).not.toContain('${');
  await userEvent.click(within(drawer).getByRole('button', { name: 'Preview (dry run)' }));
  await within(drawer).findByRole('region', { name: 'What this run will change' });
  await userEvent.click(within(drawer).getByRole('button', { name: def.title }));
  const dialog = await screen.findByRole('dialog', { name: `${def.title}?` });
  return { mock, drawer, dialog };
}

describe('Playbook confirm dialog: the message and value rendered by the API', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('revoke consent grant: shows the rendered message, never `${ … }`, and points out look-alike characters', async () => {
    const message = `Revoke the access of ${SHADY} to Microsoft Graph (Mail.Read) for this user? Type the app name to confirm.`;
    const { mock, drawer, dialog } = await openConfirm(revokeGrant as never, GRANT_INPUTS, {
      type: 'typed',
      value: SHADY,
      message,
    });
    expect(within(drawer).getByText('You’ll type a confirmation before it runs.')).toBeInTheDocument();
    expect(within(dialog).getByText(message)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('${');
    // What in the text to type can make it pass for another name: the field's description says (the invisible
    // character's code-point tag in the label is hidden from screen readers).
    const field = within(dialog).getByLabelText(/to confirm/);
    expect(field).toHaveAccessibleName('Type PDF Convert\u{435}r to confirm');
    expect(field).toHaveAccessibleDescription(
      'Check the name: it has characters that can make it pass for another \u{2014} an invisible character ' +
        '(U+200B) and a Cyrillic \u{201c}\u{435}\u{201d} (U+0435). Make sure it\u{2019}s the one you meant to ' +
        'change. To confirm, copy the name from the line above; case, spaces and invisible characters ' +
        'don\u{2019}t count.',
    );
    expect(await axeViolations()).toEqual([]);

    const go = within(dialog).getByRole('button', { name: 'Revoke delegated permission grant' });
    // Plain Latin letters don't confirm a name with a Cyrillic one.
    await userEvent.type(field, 'PDF Converter');
    expect(go).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(go);
    expect(mock.posts.filter((p) => !p.dryRun)).toHaveLength(0);
    // Case, spacing and the invisible character don't count.
    await userEvent.clear(field);
    await userEvent.type(field, '  pdf convert\u{435}r ');
    expect(go).not.toHaveAttribute('aria-disabled');
    await userEvent.click(go);
    await waitFor(() => expect(mock.posts.filter((p) => !p.dryRun)).toHaveLength(1));
    expect(mock.posts.at(-1)).toMatchObject({
      dryRun: false,
      previewRunId: PREVIEW,
      confirmation: '  pdf convert\u{435}r ',
    });
  });

  it('plain text to type: no note', async () => {
    const { dialog } = await openConfirm(revokeGrant as never, GRANT_INPUTS, {
      type: 'typed',
      value: 'Legacy Automation',
      message: null,
    });
    expect(within(dialog).getByText('Legacy Automation')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/to confirm/)).not.toHaveAccessibleDescription();
  });

  it('accents and other writing systems: only says copying is easier, no warning', async () => {
    const { dialog } = await openConfirm(revokeGrant as never, GRANT_INPUTS, {
      type: 'typed',
      value: 'Caf\u{e9} Booking',
      message: null,
    });
    expect(within(dialog).getByLabelText(/to confirm/)).toHaveAccessibleDescription(
      'It has characters a keyboard may not type: a Latin \u{201c}\u{e9}\u{201d} (U+00E9). To confirm, copy ' +
        'the name from the line above.',
    );
    expect(within(dialog).queryByText(/Check the name/)).toBeNull();
  });

  it('a value the preview didn’t produce: says so and can’t be confirmed', async () => {
    const { mock, dialog } = await openConfirm(revokeGrant as never, GRANT_INPUTS, {
      type: 'typed',
      value: null,
      message: null,
    });
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('This change can\u{2019}t be confirmed');
    expect(alert).toHaveTextContent(
      'The preview didn\u{2019}t produce the text to type. Cancel, then select Preview again. If it keeps ' +
        'happening, tell the playbook\u{2019}s owner (identity-team).',
    );
    expect(within(alert).getByRole('button', { name: `Copy Preview ${PREVIEW}` })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/to confirm/)).toBeNull();
    const go = within(dialog).getByRole('button', { name: 'Revoke delegated permission grant' });
    expect(go).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(go);
    expect(mock.posts.filter((p) => !p.dryRun)).toHaveLength(0);
    expect(await axeViolations()).toEqual([]);
  });

  it('click confirmation: shows the rendered message instead of the template', async () => {
    const { mock, dialog } = await openConfirm(revokeSessions as never, SESSION_INPUTS, {
      type: 'click',
      value: null,
      message: 'Sign a.lee@example.com out of every session?',
    });
    expect(within(dialog).getByText('Sign a.lee@example.com out of every session?')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('${');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke sessions' }));
    await waitFor(() => expect(mock.posts.filter((p) => !p.dryRun)).toHaveLength(1));
  });
});
