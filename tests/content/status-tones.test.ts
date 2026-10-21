import path from 'node:path';
import { loadContentDir, type ColumnMapEntry } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// `status` is for values that say whether something is fine — the map gives at least one of them an ok, warn or crit
// tone. A column whose values are only categories (neutral or info for all of them: a join type, a group type, a
// source) is `kind: enum`, shown as text without a status pill and its meaningless dot (design review D-16).
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));

/**
 * Pages other packages of the 2026-10-21 platform review are changing at the same time; they move their columns to
 * `enum` when those changes merge. Remove an entry once its file is migrated — the test then holds it.
 */
const PENDING = new Set<string>([]);

const SIGNAL = new Set(['ok', 'warn', 'crit']);
const toneOf = (e: ColumnMapEntry): string | undefined =>
  typeof e === 'string' ? undefined : Array.isArray(e) ? e[0] : (e as { tone: string }).tone;

interface Column {
  file: string;
  field: string;
  kind?: string;
  map?: Record<string, ColumnMapEntry>;
}

function tableColumns(): Column[] {
  const out: Column[] = [];
  for (const d of loaded.definitions) {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o.widget === 'table' && Array.isArray(o.columns))
          for (const c of o.columns as Array<Omit<Column, 'file'>>) out.push({ file: d.file, ...c });
        Object.values(o).forEach(walk);
      }
    };
    walk(d.def);
  }
  return out;
}

describe('status columns carry a signal', () => {
  const columns = tableColumns();

  it('content loads', () => {
    expect(loaded.errors).toEqual([]);
    expect(columns.filter((c) => c.kind === 'status').length).toBeGreaterThan(200);
  });

  it('every mapped status column gives at least one value an ok, warn or crit tone; categories are enum', () => {
    const categories = columns
      .filter(
        (c) => c.kind === 'status' && c.map && !Object.values(c.map).some((e) => SIGNAL.has(toneOf(e)!)),
      )
      .map((c) => `${c.file}#${c.field}`)
      .filter((key) => !PENDING.has(key));
    expect(categories).toEqual([]);
  });

  it('the pending list only names columns that still need it', () => {
    const stillStatus = new Set(
      columns
        .filter(
          (c) => c.kind === 'status' && c.map && !Object.values(c.map).some((e) => SIGNAL.has(toneOf(e)!)),
        )
        .map((c) => `${c.file}#${c.field}`),
    );
    expect([...PENDING].filter((key) => !stillStatus.has(key))).toEqual([]);
  });

  it('enum columns map values to labels', () => {
    const enums = columns.filter((c) => c.kind === 'enum');
    expect(enums.length).toBeGreaterThan(30);
    expect(enums.filter((c) => Object.values(c.map ?? {}).some((e) => typeof e !== 'string'))).toEqual([]);
  });
});
