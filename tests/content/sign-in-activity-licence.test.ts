import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Microsoft Graph answers a request that selects `signInActivity` with 403 in a tenant without Microsoft Entra ID P1,
// so the whole list fails. A datasource that reads it declares the `signInLogs` licence (on itself or on its
// definition): the page then explains what is missing instead of showing an error. `m365.licence` 2.1.0 read sign-in
// times in its Users list without declaring it (content review S2).

interface Datasource {
  request?: unknown;
  requests?: unknown;
  requires?: { licences?: string[] };
}
interface Def {
  id: string;
  status?: string;
  requires?: { licences?: string[] };
  datasources?: Record<string, Datasource>;
}

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const active = loaded.definitions.map((d) => d.def as Def).filter((d) => d.status !== 'retired');

const readers = active.flatMap((d) =>
  Object.entries(d.datasources ?? {})
    .filter(([, ds]) => /signInActivity/.test(JSON.stringify(ds.request ?? ds.requests ?? {})))
    .map(([name, ds]) => ({
      at: `${d.id} › ${name}`,
      licences: [...(d.requires?.licences ?? []), ...(ds.requires?.licences ?? [])],
    })),
);

describe('datasources that read signInActivity declare the signInLogs licence', () => {
  it('finds them', () => {
    expect(readers.map((r) => r.at)).toEqual(
      expect.arrayContaining(['m365.licence › users', 'identity.users › users']),
    );
  });

  it.each(readers.map((r) => [r.at, r.licences] as const))('%s', (_at, licences) => {
    expect(licences).toContain('signInLogs');
  });
});
