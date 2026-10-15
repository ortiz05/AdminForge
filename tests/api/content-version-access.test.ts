import { buildApp } from '@adminforge/api/src/app';
import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { MemoryPreauthStore } from '@adminforge/api/src/auth/preauth-store';
import { MemorySessionStore } from '@adminforge/api/src/auth/session-store';
import { createTokenCache, MemorySealedBlobStore } from '@adminforge/api/src/auth/token-cache';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import {
  compareSemVer,
  type ChangeListener,
  type DefinitionRecord,
  type DefinitionSource,
} from '@adminforge/api/src/definitions/types';
import { MemoryPrefsStore } from '@adminforge/api/src/prefs/prefs-store';
import type { Kind } from '@adminforge/schemas';
import { Clock, mockConfig, mockLogin, noNetwork, TEST_KEY } from './helpers';

/**
 * Published versions as Postgres keeps them: older rows stay resolvable by exact version, a retired latest version
 * hides the key from "latest". Interactive calls must only ever use the current version (M2).
 */
class VersionedSource implements DefinitionSource {
  readonly rows: DefinitionRecord[] = [];
  add(def: { kind: Kind; id: string; version: string; status?: string }) {
    this.rows.push({
      kind: def.kind,
      key: def.id,
      version: def.version,
      sha256: `${def.id}@${def.version}`,
      def: def as never,
      status: def.status === 'retired' ? 'retired' : 'published',
      source: 'git',
    });
    return this;
  }
  private latest(kind: Kind, key: string) {
    const rows = this.rows.filter((r) => r.kind === kind && r.key === key);
    return rows.sort((a, b) => compareSemVer(b.version, a.version))[0];
  }
  async list(kind?: Kind) {
    const keys = new Set(this.rows.filter((r) => !kind || r.kind === kind).map((r) => `${r.kind}:${r.key}`));
    return [...keys]
      .map((k) => this.latest(k.split(':')[0] as Kind, k.slice(k.indexOf(':') + 1))!)
      .filter((r) => r.status !== 'retired');
  }
  async get(kind: Kind, key: string, version?: string) {
    if (version)
      return this.rows.find((r) => r.kind === kind && r.key === key && r.version === version) ?? null;
    const l = this.latest(kind, key);
    return l && l.status !== 'retired' ? l : null;
  }
  onChange(_l: ChangeListener) {
    return () => undefined;
  }
  problems() {
    return [];
  }
  async close() {}
}

const page = (version: string, extra: Record<string, unknown> = {}) => ({
  kind: 'page' as const,
  id: 'identity.sign-ins',
  version,
  title: 'Sign-ins',
  owner: 'tests',
  template: 'dashboard',
  nav: { section: 'identity', label: 'Sign-ins' },
  datasources: { rows: { source: 'static', data: { value: [{ id: 1 }] } } },
  layout: [{ widget: 'kpi', data: 'rows.value', label: 'Rows' }],
  ...extra,
});

const report = (version: string, extra: Record<string, unknown> = {}) => ({
  kind: 'report' as const,
  id: 'identity.expiring',
  version,
  title: 'Expiring things',
  owner: 'tests',
  datasources: { rows: { source: 'static', data: { value: [{ name: 'a' }] } } },
  layout: [
    {
      widget: 'table',
      id: 't',
      data: 'rows.value',
      rowKey: 'name',
      columns: [{ field: 'name', label: 'Name' }],
    },
  ],
  export: { formats: ['csv'], fileName: 'expiring', data: 'rows.value', columns: 'all' },
  ...extra,
});

const ADMIN_ONLY = { requires: { portalRoles: ['Portal.Reader', 'Portal.Admin'] } };

async function setup(source: VersionedSource, roles = 'Portal.Reader') {
  const clock = new Clock();
  const app = await buildApp(mockConfig({ MOCK_ROLES: roles }), {
    database: null,
    now: clock.now,
    sessions: new MemorySessionStore(),
    preauth: new MemoryPreauthStore(),
    audit: new MemoryAuditWriter(clock.now),
    prefs: new MemoryPrefsStore(),
    tokenCache: createTokenCache(new MemorySealedBlobStore(), Buffer.from(TEST_KEY, 'base64')),
    fetch: noNetwork,
    definitions: registryFrom(source, 'db'),
  });
  await app.ready();
  const { cookie, csrf } = await mockLogin(app);
  const headers = { cookie, 'x-adminforge-csrf': csrf };
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers, payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers });
  return { app, post, get };
}

describe('interactive calls use the current published version (M2)', () => {
  // 1.0.0 was open to readers; 1.1.0 added an Admin requirement.
  const source = () => new VersionedSource().add(page('1.0.0')).add(page('1.1.0', ADMIN_ONLY));

  it('datasources/execute and execute-many refuse an older version instead of using its rules', async () => {
    const t = await setup(source());
    for (const [url, body] of [
      ['/api/datasources/execute', { page: 'identity.sign-ins', version: '1.0.0', datasource: 'rows' }],
      ['/api/datasources/execute-many', { page: 'identity.sign-ins', version: '1.0.0' }],
    ] as const) {
      const res = await t.post(url, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'version_superseded',
        message: expect.stringContaining('version 1.1.0'),
        hint: 'Reload the page to use the current version.',
      });
    }
    // The current version applies its own rules: a Reader without Portal.Admin is refused.
    const current = await t.post('/api/datasources/execute-many', {
      page: 'identity.sign-ins',
      version: '1.1.0',
    });
    expect(current.statusCode).toBe(403);
    expect(current.json().error.message).toMatch(/Portal\.Admin/);
    await t.app.close();
  });

  it('without a version, the current one is used (and the response says which)', async () => {
    const t = await setup(new VersionedSource().add(page('1.0.0')).add(page('1.1.0')));
    const res = await t.post('/api/datasources/execute-many', { page: 'identity.sign-ins' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 'identity.sign-ins', version: '1.1.0' });
    await t.app.close();
  });

  it('a retired page is refused even by its exact version; never-published stays 404', async () => {
    const t = await setup(new VersionedSource().add(page('1.0.0')).add(page('1.1.0', { status: 'retired' })));
    const old = await t.post('/api/datasources/execute-many', {
      page: 'identity.sign-ins',
      version: '1.0.0',
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toMatchObject({ code: 'definition_retired', message: /no longer available/ });
    expect((await t.post('/api/datasources/execute-many', { page: 'identity.sign-ins' })).statusCode).toBe(
      404,
    );
    expect(
      (await t.post('/api/datasources/execute-many', { page: 'identity.nope', version: '1.0.0' })).statusCode,
    ).toBe(404);
    await t.app.close();
  });

  it('report export refuses an older version (a later role, fix or retirement is never bypassed)', async () => {
    const t = await setup(new VersionedSource().add(report('1.0.0')).add(report('2.0.0', ADMIN_ONLY)));
    const res = await t.post('/api/reports/identity.expiring/export', {
      version: '1.0.0',
      format: 'csv',
      params: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('version_superseded');
    const current = await t.post('/api/reports/identity.expiring/export', { format: 'csv', params: {} });
    expect(current.statusCode).toBe(403);
    await t.app.close();
  });

  it('reading an older definition also needs the roles the current version asks for', async () => {
    const t = await setup(source());
    const res = await t.get('/api/definitions/page/identity.sign-ins?version=1.0.0');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Portal\.Reader and Portal\.Admin/);
    const admin = await setup(source(), 'Portal.Reader,Portal.Admin');
    const ok = await admin.get('/api/definitions/page/identity.sign-ins?version=1.0.0');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe('1.0.0');
    await t.app.close();
    await admin.app.close();
  });
});

describe('role checks match requires.portalRoles: every listed role (L13, L14)', () => {
  const source = () =>
    new VersionedSource()
      .add(page('1.0.0', ADMIN_ONLY))
      .add({ ...page('1.0.0'), id: 'identity.open', title: 'Open page' } as never);

  it('navigation and search hide a definition unless the user holds every listed role', async () => {
    const t = await setup(source(), 'Portal.Reader');
    const nav = await t.get('/api/nav');
    const hrefs = (nav.json().sections as Array<{ items: Array<{ href: string }> }>).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(hrefs).toContain('/p/identity.open');
    expect(hrefs).not.toContain('/p/identity.sign-ins');
    const search = await t.get('/api/search?q=sign&type=page');
    expect(search.statusCode).toBe(200);
    expect(JSON.stringify(search.json())).not.toContain('identity.sign-ins');

    const admin = await setup(source(), 'Portal.Reader,Portal.Admin');
    const adminNav = JSON.stringify((await admin.get('/api/nav')).json());
    expect(adminNav).toContain('/p/identity.sign-ins');
    expect(JSON.stringify((await admin.get('/api/search?q=sign&type=page')).json())).toContain(
      'identity.sign-ins',
    );
    await t.app.close();
    await admin.app.close();
  });

  it('saving a view needs access to the page, like reading its views', async () => {
    const t = await setup(source(), 'Portal.Reader');
    const res = await t.post('/api/views', { page: 'identity.sign-ins', name: 'Mine', state: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Portal\.Admin/);
    const ok = await t.post('/api/views', { page: 'identity.open', name: 'Mine', state: {} });
    expect(ok.statusCode).toBe(201);
    await t.app.close();
  });
});
