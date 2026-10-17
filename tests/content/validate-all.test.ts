import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  collectExpressions,
  lintExpressions,
  renderTemplate,
  validateExpressions,
} from '@adminforge/expressions';
import {
  formatContentError,
  isWriteCapable,
  loadContentDir,
  type LoadedDefinition,
} from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

const CONTENT = path.join(repoRoot, 'portal/content');

function yamlFiles(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel)).flatMap((name) => {
    const r = rel ? `${rel}/${name}` : name;
    if (name.startsWith('.')) return [];
    if (statSync(path.join(dir, r)).isDirectory())
      return name === 'fixtures' || name === 'scripts' ? [] : yamlFiles(dir, r);
    return /\.ya?ml$/.test(name) ? [r] : [];
  });
}

const loaded = await loadContentDir(CONTENT);
const defs: LoadedDefinition[] = loaded.definitions;
const byId = <T>(id: string) => defs.find((d) => d.def.id === id)!.def as unknown as T;

describe('portal/content', () => {
  it('every YAML file is a valid definition with valid cross-references', () => {
    expect(loaded.errors.map(formatContentError)).toEqual([]);
    expect(defs.map((d) => d.file).sort()).toEqual(yamlFiles(CONTENT).sort());
  });
  it('ships navigation and the starter set', () =>
    expect(defs.map((d) => `${d.def.kind}:${d.def.id}`).sort()).toEqual(
      expect.arrayContaining([
        'navigation:portal.navigation',
        'page:identity.users',
        'playbook:identity.disable-user',
        'report:identity.app-credential-expiry',
        'schedule:reports.app-credential-expiry',
        'probe:probes.graph-reachability',
        'probe:probes.arm-reachability',
      ]),
    ));
  it.each(defs.map((d) => [d.file, d] as const))('every expression in %s compiles', (_file, d) => {
    expect(
      validateExpressions(d.def).map(
        (i) => `${d.file}:${d.locate(i.segments) ?? '?'} ${i.path}: ${i.message}`,
      ),
    ).toEqual([]);
  });
  it('user data reaches $filter / $search only through $odata() / $odataSearch()', () =>
    expect(
      defs.flatMap((d) => lintExpressions(d.def).map((w) => `${d.file} ${w.path}: ${w.message}`)),
    ).toEqual([]));
  it('only references env keys declared in config/example.env', () => {
    const declared = new Set(
      readFileSync(path.join(repoRoot, 'config/example.env'), 'utf8').match(/^[A-Z0-9_]+(?==)/gm) ?? [],
    );
    const used = defs.flatMap((d) =>
      collectExpressions(d.def).flatMap((e) =>
        [...e.source.matchAll(/\benv\.([A-Za-z0-9_]+)/g)].map((m) => `${d.file}: ${m[1]}`),
      ),
    );
    expect(used.filter((u) => !declared.has(u.split(': ')[1]!))).toEqual([]);
  });
  it('$schema points at the generated schema for the kind', () => {
    for (const d of defs) {
      const ref = (d.def as { $schema?: string }).$schema;
      if (!ref) continue;
      expect(path.resolve(CONTENT, path.dirname(d.file), ref)).toBe(
        path.join(repoRoot, `portal/packages/schemas/generated/${d.def.kind}.schema.json`),
      );
    }
  });
  it('write-capable playbooks and runbooks ship tests', () =>
    expect(
      defs
        .filter(
          (d) =>
            isWriteCapable(d.def) &&
            (d.def.kind === 'playbook' || d.def.kind === 'runbook') &&
            !d.def.tests?.length,
        )
        .map((d) => d.file),
    ).toEqual([]));
});

describe('identity.users', () => {
  const query = byId<{ datasources: { users: { request: { query: unknown } } } }>('identity.users')
    .datasources.users.request.query;
  it('builds $filter with quoted OData literals', async () => {
    const q = await renderTemplate<Record<string, unknown>>(query, {
      params: { userType: 'Guest', enabled: 'Disabled', department: "O'Brien & Co", q: '' },
    });
    expect(q.$filter).toBe(
      "userType eq 'Guest' and accountEnabled eq false and department eq 'O''Brien & Co'",
    );
    expect(q).not.toHaveProperty('$search');
  });
  it('drops $filter when nothing is selected and escapes $search', async () => {
    const q = await renderTemplate<Record<string, unknown>>(query, {
      params: { userType: 'All', enabled: 'Any', q: 'a"b' },
    });
    expect(q).not.toHaveProperty('$filter');
    expect(q.$search).toBe('"displayName:a\\"b" OR "userPrincipalName:a\\"b"');
  });
});

describe('identity.app-credential-expiry', () => {
  const transform = byId<{ datasources: { credentials: { transform: string } } }>(
    'identity.app-credential-expiry',
  ).datasources.credentials.transform;
  const apps = {
    value: [
      {
        id: 'o1',
        appId: '00000000-0000-4000-8000-0000000000b1',
        displayName: 'Example HR Sync',
        passwordCredentials: [
          { keyId: 'k1', displayName: 'old', endDateTime: '2026-01-05T00:00:00Z' },
          { keyId: 'k2', displayName: 'later', endDateTime: '2026-06-01T00:00:00Z' },
        ],
        keyCredentials: [{ keyId: 'k3', displayName: 'CN=hr-sync', endDateTime: '2026-01-15T00:00:00Z' }],
      },
      {
        id: 'o2',
        appId: '00000000-0000-4000-8000-0000000000b2',
        displayName: 'Example Portal',
        passwordCredentials: [{ keyId: 'k4', displayName: 'ci', endDateTime: '2026-02-01T00:00:00Z' }],
      },
    ],
  };
  const now = '2026-01-10T00:00:00Z';
  it('lists credentials inside the window, soonest first, with KPI counts', async () => {
    const out = await renderTemplate<{
      rows: Array<{ keyId: string; state: string; daysRemaining: number }>;
      total: number;
      expired: number;
      critical: number;
    }>(transform, { value: apps, params: { days: 30, includeExpired: true }, now });
    expect(out.rows.map((r) => [r.keyId, r.daysRemaining, r.state])).toEqual([
      ['k1', -5, 'expired'],
      ['k3', 5, 'critical'],
      ['k4', 22, 'warning'],
    ]);
    expect(out).toMatchObject({ total: 3, expired: 1, critical: 1 });
  });
  it('can leave out expired credentials and handles an empty tenant', async () => {
    const out = await renderTemplate<{ rows: Array<{ keyId: string }> }>(transform, {
      value: apps,
      params: { days: 7, includeExpired: false },
      now,
    });
    expect(out.rows.map((r) => r.keyId)).toEqual(['k3']);
    expect(await renderTemplate(transform, { value: { value: [] }, params: { days: 30 }, now })).toEqual({
      rows: [],
      total: 0,
      expired: 0,
      critical: 0,
      apps: 0,
      soonApps: 0,
      expiredApps: 0,
      listCapped: false,
      partial: false,
    });
  });
});
