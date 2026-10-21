import { screen } from '@testing-library/react';
import { WIDGETS, type KeyValueConfig } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget } from './helpers';

// Design review M4 (2026-10-21): a category (a user's type, a group's membership, a host's hosting) is not a status.
// Tables show it as an `enum` column — words, no pill — and an entity's keyValue fields now do the same, so the Users
// list and the user's own page agree. A `status` field keeps its pill for values that are fine or not.

const KeyValue = WIDGETS.keyValue!.component;
const term = (name: string) => screen.getByText(name, { selector: 'dt' }).parentElement!;
const parse = (fields: unknown[]) =>
  WIDGETS.keyValue!.schema.parse({ widget: 'keyValue', data: 'user', fields }) as KeyValueConfig;

describe('keyValue enum fields', () => {
  it('show the map label (or the value) as plain words, without a status pill', async () => {
    const config = parse([
      { field: 'userType', label: 'Type', kind: 'enum', map: { Member: 'Member', Guest: 'Guest' } },
      { field: 'membership', label: 'Membership', kind: 'enum', map: { Dynamic: 'Dynamic rules' } },
      { field: 'hosting', label: 'Hosting', kind: 'enum', map: { azure: 'Azure VM' } },
      { field: 'sync', label: 'Source', kind: 'enum', map: { true: 'Synced from AD', null: 'Cloud' } },
      { field: 'blank', label: 'Blank', kind: 'enum' },
    ]);
    const { container } = renderWidget(
      KeyValue,
      config,
      ready({ userType: 'Guest', membership: 'dynamic', hosting: 'arc', sync: null, blank: '' }),
    );
    expect(term('Type')).toHaveTextContent('Guest');
    // Text values match case-insensitively, as in tables and exports.
    expect(term('Membership')).toHaveTextContent('Dynamic rules');
    // Not in the map: the value itself.
    expect(term('Hosting')).toHaveTextContent('arc');
    expect(term('Source')).toHaveTextContent('Cloud');
    expect(term('Blank')).toHaveTextContent('—');
    expect(container.querySelector('[data-status]')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('a status field keeps its pill', () => {
    const config = parse([
      { field: 'accountEnabled', label: 'Sign-in', kind: 'status', map: { true: ['ok', 'Allowed'] } },
    ]);
    renderWidget(KeyValue, config, ready({ accountEnabled: true }));
    expect(term('Sign-in').querySelector('[data-status="ok"]')).not.toBeNull();
  });

  it('the schema says which map shape belongs to which kind', () => {
    const schema = WIDGETS.keyValue!.schema;
    const base = { widget: 'keyValue', data: 'user' };
    const enumWithTone = schema.safeParse({
      ...base,
      fields: [{ field: 'userType', label: 'Type', kind: 'enum', map: { Guest: ['info', 'Guest'] } }],
    });
    expect(enumWithTone.success).toBe(false);
    expect(JSON.stringify(enumWithTone.error?.issues)).toMatch(/enum field maps each value to its label/);
    const statusWithLabel = schema.safeParse({
      ...base,
      fields: [{ field: 'accountEnabled', label: 'Sign-in', kind: 'status', map: { true: 'Allowed' } }],
    });
    expect(statusWithLabel.success).toBe(false);
    expect(JSON.stringify(statusWithLabel.error?.issues)).toMatch(/use kind: enum for plain labels/);
    expect(
      schema.safeParse({
        ...base,
        fields: [{ field: 'userType', label: 'Type', kind: 'enum', map: { Guest: 'Guest' } }],
      }).success,
    ).toBe(true);
  });
});
