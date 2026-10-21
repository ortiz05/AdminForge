import path from 'node:path';
import { loadContentDir, type ColumnMapEntry } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The rule of status-tones.test.ts for table columns, for an entity's keyValue fields (design review M4, 2026-10-21):
// `status` is for values that say whether something is fine — the map gives at least one of them an ok, warn or crit
// tone. A field whose values are only categories (neutral or info for every one: a user's type, a group's
// membership, how a session host is hosted) is `kind: enum`, shown as words like the list's column, not as a pill.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));

const SIGNAL = new Set(['ok', 'warn', 'crit']);
const toneOf = (e: ColumnMapEntry): string | undefined =>
  typeof e === 'string' ? undefined : Array.isArray(e) ? e[0] : (e as { tone: string }).tone;

interface Field {
  file: string;
  field: string;
  kind?: string;
  map?: Record<string, ColumnMapEntry>;
}

function keyValueFields(): Field[] {
  const out: Field[] = [];
  for (const d of loaded.definitions) {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o.widget === 'keyValue' && Array.isArray(o.fields))
          for (const f of o.fields as Array<Omit<Field, 'file'>>) out.push({ file: d.file, ...f });
        Object.values(o).forEach(walk);
      }
    };
    walk(d.def);
  }
  return out;
}

describe('keyValue status fields carry a signal', () => {
  const fields = keyValueFields();

  it('content loads', () => {
    expect(loaded.errors).toEqual([]);
    expect(fields.filter((f) => f.kind === 'status').length).toBeGreaterThan(40);
  });

  it('every mapped status field gives at least one value an ok, warn or crit tone; categories are enum', () => {
    const categories = fields
      .filter(
        (f) => f.kind === 'status' && f.map && !Object.values(f.map).some((e) => SIGNAL.has(toneOf(e)!)),
      )
      .map((f) => `${f.file}#${f.field}`);
    expect(categories).toEqual([]);
  });

  it('enum fields map values to labels', () => {
    const enums = fields.filter((f) => f.kind === 'enum');
    expect(enums.length).toBeGreaterThanOrEqual(9);
    expect(enums.filter((f) => Object.values(f.map ?? {}).some((e) => typeof e !== 'string'))).toEqual([]);
  });
});
