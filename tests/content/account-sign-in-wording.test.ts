import path from 'node:path';
import { loadContentDir, type ColumnMapEntry } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// One wording and one tone for the same fact wherever it shows (2026-10-21 reviews):
// - Design review L18: a person's `accountEnabled` read "Allowed / Blocked" in red on Users, "Enabled / Disabled" on a
//   group's owners, and "Blocked" in grey or amber in reports. It is "Sign-in: Allowed / Blocked", Blocked in crit, as
//   the user page's header says ("Sign-in blocked") and its actions do ("Block sign-in", "Allow sign-in").
// - Content review N4: `onPremisesSyncEnabled = false` read "No longer synced" in reports and "Cloud" on the lists.
//   It is "Cloud" everywhere — false and missing alike, as the lists' "Cloud only" filter counts them — and true is
//   "Synced from AD".
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));

interface Shown {
  file: string;
  block?: string;
  field: string;
  label: string;
  kind?: string;
  map?: Record<string, ColumnMapEntry>;
}

/** Every table column and keyValue field, with the block that shows it. */
function shown(): Shown[] {
  const out: Shown[] = [];
  for (const d of loaded.definitions) {
    if ((d.def as { status?: string }).status === 'retired') continue;
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const list = o.widget === 'table' ? o.columns : o.widget === 'keyValue' ? o.fields : undefined;
        if (Array.isArray(list))
          for (const c of list as Array<Omit<Shown, 'file' | 'block'>>)
            out.push({ file: d.file, block: o.id as string | undefined, ...c });
        Object.values(o).forEach(walk);
      }
    };
    walk(d.def);
  }
  return out;
}

const SIGN_IN = { true: ['ok', 'Allowed'], false: ['crit', 'Blocked'] };
const SOURCE = { true: 'Synced from AD', false: 'Cloud', null: 'Cloud' };

/** A person's sign-in, in the pages and reports this rule was set on. */
const PEOPLE = [
  'pages/identity/users.page.yaml#users',
  'pages/identity/user.page.yaml#security',
  'pages/identity/group.page.yaml#members',
  'pages/identity/group.page.yaml#owners',
  'reports/identity/inactive-users.report.yaml#users',
  'reports/identity/password-policies.report.yaml#users',
];

describe('one wording for the same fact', () => {
  const all = shown();
  const signIn = all.filter((c) => c.field === 'accountEnabled' || c.field.endsWith('.accountEnabled'));

  it('content loads', () => {
    expect(loaded.errors).toEqual([]);
    expect(signIn.length).toBeGreaterThan(20);
  });

  it('a person’s sign-in is "Sign-in: Allowed / Blocked", Blocked in crit', () => {
    for (const key of PEOPLE) {
      const [file, block] = key.split('#');
      const col = signIn.find((c) => c.file === file && c.block === block);
      expect(col, key).toBeDefined();
      expect({ key, label: col!.label, kind: col!.kind, map: col!.map }).toEqual({
        key,
        label: 'Sign-in',
        kind: 'status',
        map: SIGN_IN,
      });
    }
  });

  it('wherever an account’s sign-in says Allowed or Blocked, it says it the same way', () => {
    const words = signIn.filter((c) =>
      Object.values(c.map ?? {}).some(
        (e) => Array.isArray(e) && ['Allowed', 'Blocked'].includes(e[1] as string),
      ),
    );
    expect(words.length).toBeGreaterThanOrEqual(PEOPLE.length);
    expect(
      words
        .filter((c) => JSON.stringify(c.map) !== JSON.stringify(SIGN_IN))
        .map((c) => `${c.file}#${c.field}`),
    ).toEqual([]);
  });

  it('a directory sync source is "Cloud" or "Synced from AD", never "No longer synced"', () => {
    const sync = all.filter((c) => c.field === 'onPremisesSyncEnabled' && c.map);
    expect(sync.length).toBeGreaterThanOrEqual(3);
    for (const c of sync)
      expect({ at: `${c.file}#${c.block}`, label: c.label, map: c.map }).toEqual({
        at: `${c.file}#${c.block}`,
        label: 'Source',
        map: SOURCE,
      });
    const words = JSON.stringify(all.map((c) => c.map ?? {}));
    expect(words).not.toMatch(/No longer synced/);
    // The lists fold it into the same two words.
    for (const c of all.filter((x) => x.field === 'sourceLabel'))
      expect(c.map, `${c.file}#${c.block}`).toEqual({ Cloud: 'Cloud', Synced: 'Synced from AD' });
  });
});
