// @adminforge/widgets — the widget registry (§7.4). Each widget is a folder: schema.ts (zod config, registered with
// @adminforge/schemas), Widget.tsx (built only from @adminforge/ui primitives and tokens), fixtures.ts, index.ts.

export * from './types';
export { WIDGETS, getWidget, parseWidgetConfig, type ConfigProblem } from './registry';
export { WIDGET_SCHEMAS, WIDGET_TYPES, registerWidgetSchemas, type WidgetType } from './schemas';
export {
  ActionBarConfig,
  ChartConfig,
  KeyValueConfig,
  KpiConfig,
  LicenceGateConfig,
  ListConfig,
  MarkdownConfig,
  ProbeStatusConfig,
  StatusGridConfig,
  TableConfig,
  TimelineConfig,
} from './schemas';

// Building blocks the page renderer shares with widgets.
export { ActionButton, launchPlaybook, playbookLabel, isExternal } from './lib/actions';
export { evaluateTemplate, hasExpression, simplePath, tryResolveSync, useRowTemplates, useTemplate, useWhen } from './lib/expr';
export { VALUE_FORMATS, formatBytes, formatValue, type ValueFormat } from './lib/format';
export { asRows, getPath, humanize, splitDataRef } from './lib/path';
export { mapStatus, TONE_LABEL, type Status, type StatusMap } from './lib/status';
export { contentHref, createWidgetRuntime } from './lib/runtime';
export { WidgetPanel } from './lib/WidgetPanel';
export { ActionSpec, EmptySpec } from './lib/schema-common';
export { FEATURE_INFO, LicenceGatePanel, type MissingFeature } from './widgets/licence-gate/Widget';
export { Markdown, parseBlocks, safeHref } from './widgets/markdown/markdown';
export { foldSeries, prepareHeatGrid, prepareSeries, prepareSlices } from './widgets/chart/prepare';
export { toDataColumn } from './widgets/table/Widget';

// Story data (component tests, the design page).
export { FIXTURE_NOW } from './lib/fixtures';
export { actionBarFixtures } from './widgets/action-bar/fixtures';
export { chartFixtures } from './widgets/chart/fixtures';
export { keyValueFixtures } from './widgets/key-value/fixtures';
export { kpiFixtures } from './widgets/kpi/fixtures';
export { licenceGateFixtures } from './widgets/licence-gate/fixtures';
export { listFixtures } from './widgets/list/fixtures';
export { markdownFixtures } from './widgets/markdown/fixtures';
export { probeStatusFixtures } from './widgets/probe-status/fixtures';
export { statusGridFixtures } from './widgets/status-grid/fixtures';
export { tableFixtures } from './widgets/table/fixtures';
export { timelineFixtures } from './widgets/timeline/fixtures';
