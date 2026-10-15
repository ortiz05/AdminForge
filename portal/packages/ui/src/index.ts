// @adminforge/ui — recipes, primitives, and helpers. Pages compose these; they never style themselves.

export { tv, cn, twMergeConfig } from './recipes/tv';
// Recipes: the only place variants and sizes are defined (§6.8). Pages restyle by composing these.
export * from './recipes/avatar';
export * from './recipes/badge';
export * from './recipes/brand';
export * from './recipes/button';
export * from './recipes/chart';
export * from './recipes/code-block';
export * from './recipes/command';
export * from './recipes/data-table';
export * from './recipes/drawer';
export * from './recipes/field';
export * from './recipes/filter-bar';
export * from './recipes/id-chip';
export * from './recipes/kbd';
export * from './recipes/kpi';
export * from './recipes/meter';
export * from './recipes/overlay';
export * from './recipes/page-header';
export * from './recipes/panel';
export * from './recipes/skeleton';
export * from './recipes/states';
export * from './recipes/status-pill';
export * from './recipes/tabs';
export * from './recipes/timeline';
export * from './recipes/toast';
export * from './recipes/toggles';
export * from './recipes/tooltip';

export * from './lib/format';
export { escapeMarkdown, escapeMarkdownInline, safeUrl } from './lib/links';
export { useCopy, useCssVarPx, useHtmlAttribute, useMediaQuery, useNow } from './lib/hooks';
export { STATUS_ICON, STATUS_SEVERITY, STATUS_TONES, type StatusTone } from './lib/status';

export { Avatar } from './primitives/Avatar';
export { Badge, type BadgeProps } from './primitives/Badge';
export { AnvilMark, Brand, type BrandProps } from './primitives/Brand';
export { Button, type ButtonProps } from './primitives/Button';
export { Chart, MAX_SERIES, type ChartProps, type ChartSeries } from './primitives/Chart';
export { CodeBlock, type CodeBlockProps } from './primitives/CodeBlock';
export {
  CommandGroup,
  CommandItem,
  CommandPalette,
  CommandSeparator,
  type CommandPaletteProps,
} from './primitives/Command';
export { ConfirmDialog, type ConfirmDialogProps } from './primitives/ConfirmDialog';
export {
  DATE_FILTER_PRESETS,
  DataTable,
  MUTED as TABLE_MUTED_TEXT,
  matchesDateFilter,
  type ColumnFilterKind,
  type ColumnKind,
  type DataColumn,
  type DataTableError,
  type DataTableProps,
  type DataTableView,
  type IdentityValue,
  type RangeFilterValue,
  type StatusValue,
  type TableDensity,
} from './primitives/DataTable';
export { Dialog, DialogClose, type DialogProps } from './primitives/Dialog';
export { Drawer, type DrawerProps } from './primitives/Drawer';
export {
  FieldShell,
  Textarea,
  TextField,
  type FieldShellProps,
  type TextareaProps,
  type TextFieldProps,
} from './primitives/Field';
export {
  FilterBar,
  type Facet,
  type FacetOption,
  type FilterBarProps,
  type FilterChip,
} from './primitives/FilterBar';
export { Icon, loadIcons, type IconProps } from './primitives/Icon';
export { IconButton, type IconButtonProps } from './primitives/IconButton';
export { IdChip, type IdChipProps } from './primitives/IdChip';
export { Kbd, modKey, type KbdProps } from './primitives/Kbd';
export { Kpi, KpiStrip, type KpiDelta, type KpiProps } from './primitives/Kpi';
export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuTrigger,
} from './primitives/Menu';
export { Meter, type MeterProps } from './primitives/Meter';
export {
  Breadcrumbs,
  PageHeader,
  type Crumb,
  type LinkComponent,
  type PageHeaderProps,
} from './primitives/PageHeader';
export { Panel, type PanelProps } from './primitives/Panel';
export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger } from './primitives/Popover';
export { ProvenanceFooter, type Provenance, type ProvenanceFooterProps } from './primitives/ProvenanceFooter';
export { Select, type SelectOption, type SelectProps } from './primitives/Select';
export { Skeleton, SkeletonText, type SkeletonProps } from './primitives/Skeleton';
export { Sparkline, type SparklineProps } from './primitives/Sparkline';
export { EmptyState, ErrorState, type EmptyStateProps, type ErrorStateProps } from './primitives/States';
export { StatusPill, type StatusPillProps } from './primitives/StatusPill';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './primitives/Tabs';
export { Timeline, type TimelineItem } from './primitives/Timeline';
export { ToastProvider, useToast, type ToastOptions } from './primitives/Toast';
export {
  Checkbox,
  SegmentedControl,
  Switch,
  type CheckboxProps,
  type SegmentedControlProps,
  type SegmentOption,
  type SwitchProps,
} from './primitives/Toggles';
export { Tooltip, type TooltipProps } from './primitives/Tooltip';
export * from './icons';
