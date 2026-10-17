import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// identity.app-registration-risks 2.0.x runs every check natively in one pass ($idsWhere, the …Any operators) and
// checks plain HTTP per URI only for apps with an http:// URI. These pin the redirect URI and permission rules.
const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const transform = (definitions.find((d) => d.def.id === 'identity.app-registration-risks')!.def as Def)
  .datasources.appList.transform as string;
const MAIL_RW = '00000000-0000-4000-8000-0000000000aa';

const app = (id: string, uris: { web?: string[]; spa?: string[]; publicClient?: string[] }, extra = {}) => ({
  id,
  appId: `app-${id}`,
  displayName: `App ${id}`,
  signInAudience: 'AzureADMyOrg',
  createdDateTime: '2026-01-01T00:00:00Z',
  web: { redirectUris: uris.web ?? [], implicitGrantSettings: { enableAccessTokenIssuance: false } },
  spa: { redirectUris: uris.spa ?? [] },
  publicClient: { redirectUris: uris.publicClient ?? [] },
  requiredResourceAccess: [],
  ...extra,
});

async function run(apps: unknown[], severity = 'all'): Promise<Record<string, Record<string, unknown>>> {
  const out = (await renderString(transform, {
    now: '2026-10-17T12:00:00Z',
    user: {},
    env: {},
    params: { severity },
    ds: { graphApi: { [MAIL_RW]: 'Mail.ReadWrite' } },
    value: { value: apps },
  })) as Def;
  return Object.fromEntries((out.rows as Def[]).map((r) => [r.id, r]));
}

describe('identity.app-registration-risks redirect URIs', () => {
  it('plain HTTP is a web or SPA URI on http:// that is not localhost, 127.0.0.1 or [::1]', async () => {
    const rows = await run([
      app('local-only', {
        web: ['http://localhost', 'HTTP://LOCALHOST:5000/cb', 'http://127.0.0.1/x', 'http://[::1]:8080'],
      }),
      app('fake-local', { web: ['http://localhost.evil.example.com/cb'] }),
      app('mixed', { web: ['http://localhost:3000', 'http://app.example.com'] }),
      app('spa', { spa: ['http://spa.example.com'] }),
      app('native', { publicClient: ['http://native.example.com'] }),
      app('https', { web: ['https://secure.example.com'] }),
    ]);
    expect(rows['fake-local']).toMatchObject({ plainHttpUri: true, severity: 'crit' });
    expect(rows.mixed).toMatchObject({ plainHttpUri: true, localhostUri: true, severity: 'crit' });
    expect(rows.spa).toMatchObject({ plainHttpUri: true });
    // Localhost only: info (localhost redirect), never plain HTTP; public-client URIs aren't web/SPA redirects.
    expect(rows['local-only']).toMatchObject({ plainHttpUri: false, localhostUri: true, severity: 'info' });
    expect(rows.native).toBeUndefined();
    expect(rows.https).toBeUndefined();
  });

  it('wildcards and shared hosting are checked on web, SPA and public client URIs', async () => {
    const rows = await run([
      app('wild', { publicClient: ['https://*.example.com'] }),
      app('pages', { spa: ['https://team.github.io/app'] }),
      app('cloud', { web: ['https://APP.AZUREWEBSITES.NET/signin'] }),
    ]);
    expect(rows.wild).toMatchObject({ wildcardUri: true, severity: 'crit' });
    expect(rows.pages).toMatchObject({ sharedHostingUri: true, severity: 'warn' });
    expect(rows.cloud).toMatchObject({ sharedHostingUri: true, severity: 'warn' });
  });

  it('every finding field is true or false on every listed app; one app still comes back as a list', async () => {
    const out = (await renderString(transform, {
      now: '2026-10-17T12:00:00Z',
      user: {},
      env: {},
      params: { severity: 'warn' },
      ds: { graphApi: { [MAIL_RW]: 'Mail.ReadWrite' } },
      value: {
        value: [
          app('perm', {}, { requiredResourceAccess: [{ resourceAccess: [{ id: MAIL_RW, type: 'Role' }] }] }),
          app('clean', {}),
        ],
      },
    })) as Def;
    expect(Array.isArray(out.rows)).toBe(true);
    expect(out.rows).toHaveLength(1);
    const [row] = out.rows as Def[];
    expect(row).toMatchObject({ id: 'perm', criticalPermissions: true, severity: 'warn' });
    for (const f of [
      'wildcardUri',
      'plainHttpUri',
      'sharedHostingUri',
      'implicitAccessTokens',
      'publicClient',
      'localhostUri',
    ])
      expect(row[f]).toBe(false);
    expect(row).not.toHaveProperty('requiredResourceAccess');
  });

  it('critical permissions need an application permission (type Role), as before 2.0', async () => {
    const perms = (resourceAccess: unknown[]) => ({ requiredResourceAccess: [{ resourceAccess }] });
    const out = await run([
      app('role', {}, perms([{ id: MAIL_RW, type: 'Role' }])),
      app('scope', {}, perms([{ id: MAIL_RW, type: 'Scope' }])),
      app('other', {}, perms([{ id: '00000000-0000-4000-8000-0000000000bb', type: 'Role' }])),
    ]);
    expect(out.role).toMatchObject({ criticalPermissions: true });
    expect(out.scope).toBeUndefined();
    expect(out.other).toBeUndefined();
  });
});
