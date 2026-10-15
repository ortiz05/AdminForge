import type { TableWidgetConfig } from '@adminforge/schemas';
import { splitDataRef, type FeatureState, type MissingFeature } from '@adminforge/widgets';
import { featureKeyFor, type Capabilities, type PageDefinition } from './api';
import { blockId, type Block } from './blocks';

/** Keys whose values are datasource references (not templates). */
const DATA_KEYS = new Set(['data', 'delta', 'trend']);

/** Datasource names used by these blocks/templates: `data` refs plus identifiers inside `${ … }`. */
export function neededDatasources(def: PageDefinition, parts: unknown[]): string[] {
  const names = Object.keys(def.datasources ?? {});
  if (!names.length) return [];
  const found = new Set<string>();
  const patterns = names.map((n) => [n, new RegExp(`(^|[^A-Za-z0-9_.$])${n}\\b`)] as const);
  const visit = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (key && DATA_KEYS.has(key)) {
        const root = splitDataRef(v).root;
        if (names.includes(root)) found.add(root);
      }
      if (v.includes('${')) for (const [n, re] of patterns) if (re.test(v)) found.add(n);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  parts.forEach((p) => visit(p));
  return names.filter((n) => found.has(n));
}

/**
 * Gives every block a stable id (`<widget><index>`, prefixed per tab) unless content set one, so URL state
 * (`<table>.sort`…) and React keys don't depend on how the template splits blocks into grids.
 */
export function withIds(blocks: readonly unknown[], prefix = ''): Block[] {
  return (blocks as Block[]).map((b, i) => (b.id ? b : { ...b, id: `${prefix}${b.widget}${i}` }));
}

/** Blocks shown now: an entity/settings page's active tab (or its layout), everything else its layout. */
export function activeBlocks(def: PageDefinition, tab: string | undefined): { blocks: Block[]; tab?: string } {
  const tabs = def.tabs ?? [];
  if (tabs.length && (def.template === 'entity' || def.template === 'settings' || !def.layout?.length)) {
    const t = tabs.find((x) => x.id === tab) ?? tabs[0]!;
    return { blocks: withIds(t.layout, `${t.id}_`), tab: t.id };
  }
  return { blocks: withIds(def.layout ?? []) };
}

export interface TableColumns {
  all: string[];
  visible: string[];
}

/** Table blocks (with ids, see withIds) → their URL namespace and column ids (for `<ns>.cols`). */
export function tableColumns(blocks: readonly Block[]): Record<string, TableColumns> {
  const out: Record<string, TableColumns> = {};
  blocks.forEach((b, i) => {
    if (b.widget !== 'table') return;
    const cols = ((b as unknown as TableWidgetConfig).columns ?? []).filter((c) => c && typeof c.field === 'string');
    out[blockId(b, i)] = { all: cols.map((c) => c.field), visible: cols.filter((c) => !c.hidden).map((c) => c.field) };
  });
  return out;
}

export interface LicenceState {
  /** Declared licences the tenant lacks (all of them — any one would do). Empty = fine or unknown. */
  missing: MissingFeature[];
}

/**
 * `requires.licences` (any of): gate only when every declared licence is known to be missing. Unknown licence
 * names or unreadable licences never block (the datasource reports a precise error instead).
 */
export function licenceState(def: PageDefinition, caps: Capabilities | undefined): LicenceState {
  const declared = def.requires?.licences ?? [];
  if (!declared.length || !caps) return { missing: [] };
  const resolved = declared.map((l) => {
    const key = featureKeyFor(l, caps);
    return { key: key ?? l, state: key ? (caps.features[key] as FeatureState) : undefined };
  });
  if (resolved.some((r) => !r.state || r.state.available !== false)) return { missing: [] };
  return { missing: resolved };
}

/** "Identity" for `nav.section: identity` (falls back to the key, capitalised). */
export function sectionLabel(def: PageDefinition, sections: Array<{ key: string; label: string }> | undefined): string | undefined {
  const key = def.nav?.section;
  if (!key) return undefined;
  return sections?.find((s) => s.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1);
}
