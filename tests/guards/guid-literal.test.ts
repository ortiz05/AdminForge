import { committableFiles, readText } from '../lib/repo';

// One GUID pattern (organization review O-07): runtime code checks GUIDs with `isGuid` / `GUID_RE` / `GUID_PATTERN`
// from @adminforge/schemas (portal/packages/schemas/src/guid.ts), not its own regex. The pattern is written out there
// and in the files below only — each where a dependency on @adminforge/schemas would be wrong, or where the GUID is
// part of a more specific shape. An entry holds the number of literals the file may keep: a new one fails, and so does
// an entry that no longer matches (lower or remove it).
const SHARED = 'portal/packages/schemas/src/guid.ts';

const ALLOWED: Record<string, { count: number; why: string }> = {
  'portal/packages/connectors/src/log-analytics.ts': {
    count: 1,
    why: '@adminforge/connectors has no internal dependencies (docs/onboarding/03-repository-map.md)',
  },
  'portal/apps/api/src/execution/outbound.ts': {
    count: 1,
    why: "Microsoft's first-party application id families (`xxxxxxxx-0000-0000-c000-000000000000`), not any GUID",
  },
};

/**
 * A hex class repeated eight times and then a hyphen: `[0-9a-f]{8}-`, `[0-9a-fA-F]{8}-`, `[\da-f]{8}\-`,
 * `[a-f0-9]{8}(?:-…`, in a regex literal or a string.
 */
const LITERAL = /\[[^\]\n]{1,16}\]\{8\}(?:\\?-|\(\?:\\?-)/g;

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const runtime = committableFiles().filter(
  (f) => f.startsWith('portal/') && CODE.test(f) && !f.includes('/node_modules/') && !f.includes('/dist/'),
);

const count = (source: string) => [...source.matchAll(LITERAL)].length;

describe('runtime code uses the one GUID pattern', () => {
  it('finds the runtime files and the shared module', () => {
    expect(runtime.length).toBeGreaterThan(100);
    expect(count(readText(SHARED) ?? '')).toBe(1);
  });

  it('writes the GUID pattern out only in the shared module and the allow-list', () => {
    const found = Object.fromEntries(
      runtime
        .filter((f) => f !== SHARED)
        .map((f) => [f, count(readText(f) ?? '')] as const)
        .filter(([, n]) => n > 0),
    );
    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.count]));
    expect(found).toEqual(allowed);
  });

  // Control: the detector sees the spellings the copies used, and not other hex shapes.
  it.each([
    ['/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', 1],
    ['/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/', 1],
    ["'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'", 1],
    ['/[\\da-f]{8}\\-[\\da-f]{4}/', 1],
    ['/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i', 1],
    ['/^[0-9a-f]{64}$/', 0],
    ['/^#[0-9a-f]{6}$/i', 0],
    ['/^[0-9a-f-]{36}$/i', 0],
  ])('%s → %i', (source, n) => {
    expect(count(source)).toBe(n);
  });
});
