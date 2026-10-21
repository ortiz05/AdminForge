import type { ChangeListener, DefinitionSource } from '@adminforge/api/src/definitions/types';
import { EventBus, type PortalEvent } from '@adminforge/api/src/events/bus';

// `definitions.changed` reaches every signed-in browser, whatever their roles. Naming the changed keys would tell a
// Reader which admin-only pages, playbooks or portal-authored definitions exist and when they change, so browsers get
// `{all: true}` without keys (they refetch content either way); the keys stay server-side, where the caches use them.
function source() {
  let listener: ChangeListener | null = null;
  const src: Pick<DefinitionSource, 'onChange'> = {
    onChange: (l) => {
      listener = l;
      return () => (listener = null);
    },
  };
  return { src: src as DefinitionSource, emit: (c: Parameters<ChangeListener>[0]) => listener?.(c) };
}

describe('definitions.changed audience', () => {
  it('browsers get {all: true} without the changed keys', () => {
    const bus = new EventBus();
    const { src, emit } = source();
    bus.wire({ definitions: src });
    const got: PortalEvent[] = [];
    bus.subscribe((e) => got.push(e));
    emit({ keys: ['page:admin.break-glass', 'playbook:identity.reset-mfa'] });
    emit({ all: true });
    expect(got).toEqual([
      { type: 'definitions.changed', data: { all: true } },
      { type: 'definitions.changed', data: { all: true } },
    ]);
    expect(JSON.stringify(got)).not.toMatch(/break-glass|reset-mfa/);
  });

  it('nothing changed, nothing sent', () => {
    const bus = new EventBus();
    const { src, emit } = source();
    bus.wire({ definitions: src });
    const got: PortalEvent[] = [];
    bus.subscribe((e) => got.push(e));
    emit({ keys: [] });
    expect(got).toEqual([]);
  });

  it('stops relaying when closed', async () => {
    const bus = new EventBus();
    const { src, emit } = source();
    bus.wire({ definitions: src });
    const got: PortalEvent[] = [];
    bus.subscribe((e) => got.push(e));
    await bus.close();
    emit({ all: true });
    expect(got).toEqual([]);
  });
});
