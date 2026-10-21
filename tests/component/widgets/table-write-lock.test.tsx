import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UNSAFE_LINK_REASON, WIDGETS, type PlaybookWriteState, type TableConfig } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget, spyRuntime } from './helpers';

// Design review H1 (2026-10-21): a table's row menu and bulk bar show write access the way every other content action
// does (D-18) — the lock glyph and why while unarmed (still clickable: the drawer previews), the ember dot once armed,
// nothing for a read playbook or a link. The row menu decides "opens in a new tab" from the evaluated target with the
// shared link rule (`safeUrl`), not from the raw template.

const HINT = 'Arm write access to run this; previewing it doesn’t need it.';
const WRITES = new Set(['identity.disable-user', 'identity.add-group-members']);

const Table = WIDGETS.table!.component;
const config = WIDGETS.table!.schema.parse({
  widget: 'table',
  id: 'users',
  data: 'users',
  rowKey: 'id',
  columns: [{ field: 'name', label: 'Name' }],
  rowActions: [
    { playbook: 'identity.disable-user', label: 'Block sign-in', inputs: { userId: '${ row.id }' } },
    { playbook: 'identity.revoke-sessions', label: 'Revoke sessions', inputs: { userId: '${ row.id }' } },
    // External only once evaluated: the raw template starts with "${", not "https:".
    {
      label: 'Open in Entra admin center',
      href: "${ 'https://entra.microsoft.com/#user/' & $encode(row.id) }",
    },
    { label: 'Open target', href: '${ row.target }' },
  ],
  bulkActions: [
    {
      playbook: 'identity.add-group-members',
      label: 'Add to group',
      forEach: { inputs: { userIds: '${ [row.id] }' } },
      maxItems: 2,
    },
    {
      playbook: 'identity.revoke-sessions',
      label: 'Revoke sessions',
      forEach: { inputs: { userId: '${ row.id }' } },
    },
  ],
}) as TableConfig;

const ROWS = [
  { id: 'u1', name: 'Avery Example', target: 'javascript:alert(1)' },
  { id: 'u2', name: 'Blake Example', target: '/p/identity.user?id=u2' },
  { id: 'u3', name: 'Casey Example', target: '/p/identity.user?id=u3' },
];

function setup(armed: boolean | undefined) {
  const write = (playbook: string | undefined): PlaybookWriteState | undefined =>
    armed === undefined || !playbook || !WRITES.has(playbook)
      ? undefined
      : armed
        ? { armed: true }
        : { armed: false, hint: HINT };
  const spies = spyRuntime({ usePlaybookWrite: write });
  const view = renderWidget(Table, config, ready(ROWS), spies.runtime);
  return { ...view, ...spies, user: userEvent.setup() };
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
}

describe('table row menu and write access', () => {
  it('unarmed: the write item shows the lock and why, a read item stays plain; the write item still opens', async () => {
    const { user, openPlaybook } = setup(false);
    const menu = await openMenu(user, 'Avery Example');
    const block = within(menu).getByRole('menuitem', { name: 'Block sign-in' });
    const revoke = within(menu).getByRole('menuitem', { name: 'Revoke sessions' });
    expect(block.querySelector('[data-write-lock]')).not.toBeNull();
    expect(block).toHaveAccessibleDescription(HINT);
    expect(block).not.toHaveAttribute('aria-disabled');
    expect(revoke.querySelector('[data-write-lock]')).toBeNull();
    expect(revoke).not.toHaveAccessibleDescription(HINT);
    expect(menu.querySelector('.af-armed-dot')).toBeNull();
    expect(await axeViolations()).toEqual([]);
    await user.click(block);
    await waitFor(() =>
      expect(openPlaybook).toHaveBeenCalledWith({
        playbook: 'identity.disable-user',
        inputs: { userId: 'u1' },
      }),
    );
  });

  it('armed: the ember dot on the write item only, no lock', async () => {
    const { user } = setup(true);
    const menu = await openMenu(user, 'Avery Example');
    const block = within(menu).getByRole('menuitem', { name: 'Block sign-in' });
    const revoke = within(menu).getByRole('menuitem', { name: 'Revoke sessions' });
    expect(block.querySelector('.af-armed-dot')).not.toBeNull();
    expect(block.querySelector('[data-write-lock]')).toBeNull();
    expect(revoke.querySelector('.af-armed-dot')).toBeNull();
  });

  it('decides "opens in a new tab" from the evaluated target, and shows an unsafe target as text', async () => {
    const { user } = setup(undefined);
    const menu = await openMenu(user, 'Avery Example');
    // The item says it opens a new tab once its target is known to leave the portal.
    const entra = await within(menu).findByRole('menuitem', {
      name: 'Open in Entra admin center (opens in a new tab)',
    });
    expect(entra).not.toHaveAttribute('aria-disabled');
    const unsafe = within(menu).getByRole('menuitem', { name: 'Open target' });
    await waitFor(() => expect(unsafe).toHaveAttribute('aria-disabled', 'true'));
    expect(unsafe).toHaveAccessibleDescription(UNSAFE_LINK_REASON);
  });

  it('an in-app target is not marked as opening a new tab', async () => {
    const { user } = setup(undefined);
    const menu = await openMenu(user, 'Blake Example');
    const item = within(menu).getByRole('menuitem', { name: 'Open target' });
    await waitFor(() => expect(item).not.toHaveAttribute('aria-disabled'));
    expect(item).toHaveAccessibleName('Open target');
  });
});

describe('table bulk bar and write access', () => {
  const select = async (user: ReturnType<typeof userEvent.setup>, ...names: string[]) => {
    for (const n of names) await user.click(screen.getByRole('checkbox', { name: `Select ${n}` }));
    return screen.getByRole('region', { name: 'Bulk actions' });
  };

  it('unarmed: the write action shows the lock and why but still opens the drawer with the items', async () => {
    const { user, openPlaybook } = setup(false);
    const bar = await select(user, 'Avery Example');
    const add = await within(bar).findByRole('button', { name: 'Add to group' });
    const revoke = within(bar).getByRole('button', { name: 'Revoke sessions' });
    expect(add.querySelector('[data-write-lock]')).not.toBeNull();
    expect(add).toHaveAccessibleDescription(HINT);
    expect(add).not.toHaveAttribute('aria-disabled');
    expect(revoke.querySelector('[data-write-lock]')).toBeNull();
    expect(bar.querySelector('.af-armed-dot')).toBeNull();
    expect(await axeViolations()).toEqual([]);
    await user.click(add);
    await waitFor(() =>
      expect(openPlaybook).toHaveBeenCalledWith({
        playbook: 'identity.add-group-members',
        items: [{ userIds: ['u1'], $label: 'Avery Example' }],
      }),
    );
  });

  it('armed: the ember dot on the write action only', async () => {
    const { user } = setup(true);
    const bar = await select(user, 'Avery Example');
    const add = await within(bar).findByRole('button', { name: 'Add to group' });
    expect(add.querySelector('.af-armed-dot')).not.toBeNull();
    expect(add.querySelector('[data-write-lock]')).toBeNull();
    expect(
      within(bar).getByRole('button', { name: 'Revoke sessions' }).querySelector('.af-armed-dot'),
    ).toBeNull();
  });

  it('too many rows: the selection limit is what the button says, and it stays inert', async () => {
    const { user, openPlaybook } = setup(false);
    const bar = await select(user, 'Avery Example', 'Blake Example', 'Casey Example');
    const add = await within(bar).findByRole('button', { name: 'Add to group' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add).toHaveAccessibleDescription('Select at most 2 rows for add to group.');
    await user.click(add);
    expect(openPlaybook).not.toHaveBeenCalled();
  });
});
