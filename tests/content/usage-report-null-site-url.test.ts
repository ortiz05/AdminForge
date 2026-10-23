import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Usage reports mark names as concealed when the first row's siteUrl isn't a URL. A first row whose siteUrl is null
// (a site the report lists without one) made `$exists(…) and $substring(…)` throw — "Argument 1 of function "and"
// does not match function signature" — and the weekly SharePoint site usage schedule failed on it (2026-10-19).
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => loaded.definitions.find((d) => d.def.id === id)!.def;
const row = (over: Record<string, unknown>) => ({
  siteId: 'a',
  siteUrl: 'https://exampleorg.sharepoint.com/sites/a',
  ownerDisplayName: 'Avery Engineer',
  ownerPrincipalName: 'avery@example.com',
  isDeleted: false,
  lastActivityDate: '2026-01-01',
  storageUsedInBytes: 5,
  storageAllocatedInBytes: 100,
  fileCount: 1,
  activeFileCount: 1,
  pageViewCount: 1,
  ...over,
});

describe.each(['m365.sharepoint-site-usage', 'm365.onedrive-usage', 'm365.sharepoint-sites'])('%s', (id) => {
  const d = def(id);
  const [name] = Object.entries(d.datasources as Record<string, Def>).find(([, ds]) =>
    String(ds.transform ?? '').includes('"concealed"'),
  )!;
  const run = (rows: unknown[]) =>
    renderString(d.datasources[name].transform, {
      now: '2026-10-22T12:00:00Z',
      user: {},
      env: {},
      params: {},
      ds: {},
      value: { value: rows },
    }) as Promise<Def>;

  it('still reads the report when the first site has no URL', async () => {
    const out = await run([row({ siteUrl: null }), row({ siteId: 'b' })]);
    expect(out.concealed).toBe(false);
  });

  it('marks hashed names as concealed', async () => {
    expect((await run([row({ siteUrl: '3f2a9c71' })])).concealed).toBe(true);
  });
});
