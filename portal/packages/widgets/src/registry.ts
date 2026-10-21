import { humanize } from './lib/path';
import { withWidgetBoundary } from './lib/WidgetPanel';
import type { WidgetDefinition } from './types';
import { actionBarWidget } from './widgets/action-bar';
import { chartWidget } from './widgets/chart';
import { keyValueWidget } from './widgets/key-value';
import { kpiWidget } from './widgets/kpi';
import { licenceGateWidget } from './widgets/licence-gate';
import { listWidget } from './widgets/list';
import { markdownWidget } from './widgets/markdown';
import { probeStatusWidget } from './widgets/probe-status';
import { statusGridWidget } from './widgets/status-grid';
import { tableWidget } from './widgets/table';
import { timelineWidget } from './widgets/timeline';
import './schemas';

// Component prop types differ per widget; the renderer validates config with `schema` before rendering.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEFINITIONS: Record<string, WidgetDefinition<any>> = {
  kpi: kpiWidget,
  table: tableWidget,
  chart: chartWidget,
  list: listWidget,
  keyValue: keyValueWidget,
  statusGrid: statusGridWidget,
  timeline: timelineWidget,
  markdown: markdownWidget,
  actionBar: actionBarWidget,
  licenceGate: licenceGateWidget,
  probeStatus: probeStatusWidget,
};

/** The config key that names a block on the page, where it isn't `title` (a timeline's `title` is per event). */
const LABEL_KEY: Record<string, string> = { kpi: 'label', timeline: 'heading' };

/**
 * `widget:` type → { schema, component } (§7.4). The page renderer looks blocks up here; unknown types are
 * rejected by validation (and shown as a configuration error, never a crash). Each component renders inside an error
 * boundary, so a value a widget can't display costs that block only, never the page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WIDGETS: Record<string, WidgetDefinition<any>> = Object.fromEntries(
  Object.entries(DEFINITIONS).map(([type, def]) => [
    type,
    {
      ...def,
      component: withWidgetBoundary(def.component, { name: humanize(type), labelKey: LABEL_KEY[type] }),
    },
  ]),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getWidget(type: string): WidgetDefinition<any> | undefined {
  return Object.hasOwn(WIDGETS, type) ? WIDGETS[type] : undefined;
}

export interface ConfigProblem {
  path: string;
  message: string;
}

/** Validates one block against its widget schema: `{ ok, config }` or the problems, with paths. */
export function parseWidgetConfig(
  block: { widget: string } & Record<string, unknown>,
): { ok: true; config: unknown } | { ok: false; problems: ConfigProblem[] } {
  const def = getWidget(block.widget);
  if (!def)
    return { ok: false, problems: [{ path: 'widget', message: `Unknown widget type "${block.widget}".` }] };
  const r = def.schema.safeParse(block);
  if (r.success) return { ok: true, config: r.data };
  return {
    ok: false,
    problems: r.error.issues.map((i) => ({
      path: i.path.map(String).join('.') || 'widget',
      message: i.message,
    })),
  };
}
