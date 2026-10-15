import { widgetSchema } from '@adminforge/schemas';
import { WIDGET_TYPES, WIDGETS, getWidget, parseWidgetConfig } from '@adminforge/widgets';

describe('widget registry', () => {
  it('has exactly the documented widget types (docs/widgets.md)', () => {
    expect([...WIDGET_TYPES].sort()).toEqual(
      ['actionBar', 'chart', 'keyValue', 'kpi', 'licenceGate', 'list', 'markdown', 'probeStatus', 'statusGrid', 'table', 'timeline'].sort(),
    );
    expect(Object.keys(WIDGETS).sort()).toEqual([...WIDGET_TYPES].sort());
    for (const t of WIDGET_TYPES) {
      expect(getWidget(t)?.type).toBe(t);
      expect(typeof getWidget(t)?.component).toBe('function');
    }
    expect(getWidget('nope')).toBeUndefined();
    expect(getWidget('constructor')).toBeUndefined();
  });

  it('importing @adminforge/widgets registers every schema with @adminforge/schemas', () => {
    for (const t of WIDGET_TYPES) expect(widgetSchema(t)).toBeDefined();
  });

  it('parseWidgetConfig accepts a valid block and returns the parsed config', () => {
    const r = parseWidgetConfig({ widget: 'kpi', data: 'counts.members', label: 'Members' });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown widget types', () => {
    const r = parseWidgetConfig({ widget: 'gauge', data: 'x' });
    expect(r).toEqual({ ok: false, problems: [{ path: 'widget', message: 'Unknown widget type "gauge".' }] });
  });

  it('reports bad configuration with paths', () => {
    const kpi = parseWidgetConfig({ widget: 'kpi', data: 'counts.members' });
    expect(kpi.ok).toBe(false);
    expect(!kpi.ok && kpi.problems.map((p) => p.path)).toContain('label');

    const chart = parseWidgetConfig({ widget: 'chart', type: 'heatGrid', data: 'x.value', x: 'hour', y: 'count' });
    expect(!chart.ok && chart.problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'series' })]));

    const kv = parseWidgetConfig({ widget: 'keyValue', data: 'user', fields: [{ field: 'id', label: 'Id', kind: 'guidish' }] });
    expect(!kv.ok && kv.problems.map((p) => p.path)).toContain('fields.0.kind');

    const action = parseWidgetConfig({ widget: 'actionBar', actions: [{ label: 'Both', playbook: 'identity.x', href: '/p/x.y' }] });
    expect(!action.ok && action.problems[0]!.message).toMatch(/exactly one of playbook or href/);
  });
});
