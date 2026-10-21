import { render, screen, within } from '@testing-library/react';
import {
  WIDGETS,
  blockLabel,
  cantBeShownTitle,
  createWidgetRuntime,
  type KeyValueConfig,
  type StatusGridConfig,
} from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready } from './helpers';

// Design review L10 (2026-10-21): a block that can't be shown — it crashed while rendering, or its definition doesn't
// validate — says so in one wording, by the name the page gives it, and never by its widget type ("Key value
// couldn't be shown"). Untitled, it is "This part of the page".

function explodingRow() {
  return {
    id: 'r1',
    get name(): string {
      throw new Error('boom');
    },
  };
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('one wording for a block that can’t be shown', () => {
  it('names the block, or "this part of the page"', () => {
    expect(cantBeShownTitle('Profile')).toBe('Profile couldn’t be shown');
    expect(cantBeShownTitle(undefined)).toBe('This part of the page couldn’t be shown');
    expect(cantBeShownTitle('')).toBe('This part of the page couldn’t be shown');
  });

  it('reads the name from the key the widget uses for it', () => {
    expect(blockLabel({ widget: 'keyValue', title: 'Profile' })).toBe('Profile');
    expect(blockLabel({ widget: 'kpi', label: 'Members', title: 'ignored' })).toBe('Members');
    expect(blockLabel({ widget: 'timeline', heading: 'Audit trail', title: 'activityDisplayName' })).toBe(
      'Audit trail',
    );
    expect(blockLabel({ widget: 'statusGrid' })).toBeUndefined();
    expect(blockLabel({ widget: 'nope', title: 42 })).toBeUndefined();
  });

  it('an untitled block that crashes never shows its widget type', async () => {
    const StatusGrid = WIDGETS.statusGrid!.component;
    const config = WIDGETS.statusGrid!.schema.parse({
      widget: 'statusGrid',
      data: 'items.value',
      label: 'name',
      status: 'state',
    }) as StatusGridConfig;
    const { container } = render(
      <StatusGrid
        config={config}
        data={ready([explodingRow()])}
        runtime={createWidgetRuntime()}
        instanceId="s0"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This part of the page couldn’t be shown');
    expect(container).not.toHaveTextContent(/Status grid/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('an untitled panel whose content crashes says the same, not the widget’s name', () => {
    const KeyValue = WIDGETS.keyValue!.component;
    const config = WIDGETS.keyValue!.schema.parse({
      widget: 'keyValue',
      data: 'user',
      fields: [{ field: 'name', label: 'Name' }],
    }) as KeyValueConfig;
    const { container } = render(
      <KeyValue
        config={config}
        data={ready(explodingRow())}
        runtime={createWidgetRuntime()}
        instanceId="k0"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This part of the page couldn’t be shown');
    expect(container).not.toHaveTextContent(/Key value|Details couldn/);
  });
});
