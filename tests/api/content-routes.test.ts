import { composeNav } from '@adminforge/api/src/routes/nav';
import { parseSubscribedSkus } from '@adminforge/api/src/capabilities/licences';
import { search } from '@adminforge/api/src/search/search';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import type { DefinitionRegistry } from '@adminforge/api/src/definitions/types';
import {
  CapabilitiesResponse,
  DefinitionListResponse,
  DefinitionResponse,
  NavResponse,
  SearchResponse,
  type Navigation,
} from '@adminforge/schemas';
import { fixturesApp, setupContent, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

describe('GET /api/definitions', () => {
  it('returns the client-safe definition plus version and sha256; 404 for unknown kinds, keys and versions', async () => {
    const t = await fixturesApp(env);
    const { cookie } = await mockLogin(t.app);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/definitions/page/identity.users',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const def = DefinitionResponse.parse(res.json());
    expect(def).toMatchObject({ kind: 'page', id: 'identity.users', version: '1.0.0', title: 'Users' });
    expect(def.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(def).toHaveProperty('datasources.users.request.path', '/users');
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/definitions/page/identity.users?version=1.0.0',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/definitions/page/identity.users?version=2.0.0',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/definitions/widget/identity.users',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/definitions/page/identity.nope', headers: { cookie } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/definitions/page/identity.users' })).statusCode,
    ).toBe(401);
    await t.app.close();
  });

  it('lists definitions the roles allow, with hrefs and licence badges', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const list = DefinitionListResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/definitions?kind=page', headers: { cookie } })).json(),
    );
    expect(list.items.map((i) => i.key)).toEqual([
      'deps.backwards',
      'identity.break-glass',
      'deps.chain',
      'deps.inventory',
      'security.risky-users',
      'identity.user',
      'identity.users',
    ]);
    expect(list.items.find((i) => i.key === 'security.risky-users')).toMatchObject({
      href: '/p/security.risky-users',
      badge: 'Requires AAD_PREMIUM_P2',
    });
    const all = DefinitionListResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/definitions', headers: { cookie } })).json(),
    );
    expect(all.items.find((i) => i.kind === 'playbook')).toMatchObject({
      key: 'identity.check-user',
      href: '/playbooks/identity.check-user',
      mode: 'read',
      risk: 'low',
    });
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/definitions?kind=nope', headers: { cookie } }))
        .statusCode,
    ).toBe(400);

    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { roles: ['Portal.Reader'] },
    });
    const reader = DefinitionListResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/definitions?kind=page', headers: { cookie } })).json(),
    );
    expect(reader.items.map((i) => i.key)).not.toContain('identity.break-glass');
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/definitions/page/identity.break-glass',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);
    await t.app.close();
  });
});

describe('GET /api/nav (from content)', () => {
  it('orders sections from navigation.yaml, adds page items, badges unlicensed items, drops empty sections, filters by role', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const nav = NavResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie } })).json(),
    );
    expect(nav.sections.map((s) => s.key)).toEqual(['overview', 'identity', 'security', 'admin']);
    expect(nav.sections[0]!.items).toEqual([
      { key: 'overview', label: 'Overview', href: '/', icon: 'house' },
    ]);
    expect(nav.sections[1]!.items).toEqual([
      { key: 'identity.users', label: 'Users', href: '/p/identity.users', icon: 'users' },
      { key: 'identity.expiry', label: 'Credential expiry', href: '/p/identity.expiry', icon: 'key' },
      { key: 'identity.check-user', label: 'Check user', href: '/playbooks/identity.check-user' },
      { key: 'identity.break-glass', label: 'Break-glass', href: '/p/identity.break-glass' },
    ]);
    expect(nav.sections[2]!.items[0]).toMatchObject({
      key: 'security.risky-users',
      badge: 'Requires AAD_PREMIUM_P2',
    });
    expect(nav.sections[3]).toMatchObject({ key: 'admin', items: [{ key: 'audit', href: '/admin/audit' }] });

    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { roles: ['Portal.Reader'] },
    });
    const reader = NavResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie } })).json(),
    );
    expect(reader.sections.map((s) => s.key)).toEqual(['overview', 'identity', 'security']);
    expect(reader.sections[1]!.items.map((i) => i.key)).not.toContain('identity.break-glass');
    await t.app.close();
  });

  it('composeNav: unknown licences never badge; without navigation.yaml sections come from nav blocks', () => {
    const page = (id: string, section: string, licences?: string[]) => ({
      kind: 'page' as const,
      key: id,
      version: '1.0.0',
      sha256: 'x',
      status: 'published' as const,
      source: 'fs' as const,
      def: {
        kind: 'page',
        id,
        version: '1.0.0',
        title: id,
        owner: 't',
        template: 'list-detail',
        nav: { section },
        requires: licences ? { licences } : undefined,
        layout: [],
      } as never,
    });
    const defs = [page('a.one', 'alpha', ['AAD_PREMIUM_P2']), page('b.two', 'beta')];
    const unknown = composeNav({ navigation: undefined, definitions: defs, roles: [], licences: null });
    expect(unknown.sections.map((s) => [s.key, s.label])).toEqual([
      ['alpha', 'Alpha'],
      ['beta', 'Beta'],
    ]);
    expect(unknown.sections[0]!.items[0]!.badge).toBeUndefined();
    const lic = parseSubscribedSkus({
      value: [
        {
          skuPartNumber: 'EMS_E5',
          capabilityStatus: 'Enabled',
          prepaidUnits: { enabled: 5 },
          servicePlans: [{ servicePlanName: 'AAD_PREMIUM_P2', provisioningStatus: 'Success' }],
        },
      ],
    });
    expect(
      composeNav({
        navigation: { sections: [{ key: 'alpha', label: 'A', icon: 'x' }] } as Navigation,
        definitions: defs,
        roles: [],
        licences: lic,
      }).sections[0]!.items[0]!.badge,
    ).toBeUndefined();
  });
});

describe('GET /api/search', () => {
  it('fans out to definitions, directory objects and Azure resources, with typed hrefs', async () => {
    const t = await fixturesApp(env);
    const { cookie } = await mockLogin(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/search?q=avery', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = SearchResponse.parse(res.json());
    expect(body.sources).toEqual({ definitions: 'ok', directory: 'ok', azure: 'ok' });
    const byType = (type: string) => body.results.filter((r) => r.type === type);
    expect(byType('user')).toEqual([
      {
        type: 'user',
        id: TEST_USER_ID,
        title: 'Avery Engineer',
        subtitle: 'avery@example.com',
        href: `/p/identity.user?id=${TEST_USER_ID}`,
      },
    ]);
    expect(byType('group')[0]).toMatchObject({
      title: 'Avery Fans',
      external: true,
      href: expect.stringMatching(/^https:\/\/entra\.microsoft\.com\//),
    });
    expect(byType('device')[0]).toMatchObject({ title: 'AVERY-LAPTOP', subtitle: 'Windows' });
    expect(byType('resource')).toEqual([
      expect.objectContaining({
        title: 'avery-func',
        subtitle: 'microsoft.web/sites · rg-example',
        external: true,
        href: expect.stringMatching(/^https:\/\/portal\.azure\.com\/#@\/resource\/subscriptions\//),
      }),
    ]);

    const pages = SearchResponse.parse(
      (
        await t.app.inject({ method: 'GET', url: '/api/search?q=users&type=page', headers: { cookie } })
      ).json(),
    );
    // Title starts-with ranks before contains.
    expect(pages.results.map((r) => r.id)).toEqual(['identity.users', 'security.risky-users']);
    expect(pages.results[0]).toEqual(
      expect.objectContaining({
        type: 'page',
        id: 'identity.users',
        title: 'Users',
        href: '/p/identity.users',
      }),
    );
    expect(pages.sources).toEqual({ definitions: 'ok', directory: 'skipped', azure: 'skipped' });
    // Entity pages need an id, so the palette doesn't offer them directly.
    const entity = SearchResponse.parse(
      (
        await t.app.inject({ method: 'GET', url: '/api/search?q=user&type=page', headers: { cookie } })
      ).json(),
    );
    expect(entity.results.map((r) => r.id)).not.toContain('identity.user');
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/search?q=x&type=widget', headers: { cookie } }))
        .statusCode,
    ).toBe(400);
    await t.app.close();
  });

  it('time-boxes slow sources and reports them instead of failing', async () => {
    const records = [
      {
        kind: 'page',
        key: 'a.b',
        version: '1.0.0',
        sha256: 'x',
        status: 'published',
        source: 'fs',
        def: { kind: 'page', id: 'a.b', title: 'Alpha', owner: 't', version: '1.0.0' },
      },
    ];
    const definitions = {
      list: async (k?: string) => (k === 'page' ? records : []),
      get: async () => null,
    } as unknown as DefinitionRegistry;
    const slow = { execute: () => new Promise<never>(() => undefined) };
    const s = { userOid: 'u', roles: ['Portal.Reader'] } as SessionRecord;
    const out = await search({ definitions, outbound: slow, timeoutMs: 50 }, s, 'alpha');
    expect(out.sources).toEqual({ definitions: 'ok', directory: 'timeout', azure: 'timeout' });
    expect(out.results.map((r) => r.id)).toEqual(['a.b']);
    const failing = { execute: async () => Promise.reject(new Error('boom')) };
    expect((await search({ definitions, outbound: failing, timeoutMs: 500 }, s, 'alpha')).sources).toEqual({
      definitions: 'ok',
      directory: 'error',
      azure: 'error',
    });
  });
});

const TEST_USER_ID = '30000000-0000-4000-8000-000000000001';

describe('GET /api/me/capabilities', () => {
  it('features from subscribedSkus (with the SKU that would enable each); active roles fall back without P2; eligible degrades', async () => {
    const t = await fixturesApp(env);
    const { cookie } = await mockLogin(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/me/capabilities', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const caps = CapabilitiesResponse.parse(res.json());
    expect(Object.keys(caps.features).sort()).toEqual([
      'conditionalAccess',
      'defender',
      'exchange',
      'identityProtection',
      'intune',
      'pim',
      'sharepoint',
      'signInLogs',
      'teams',
    ]);
    expect(caps.features.conditionalAccess).toMatchObject({ available: true, sku: 'SPE_E3' });
    expect(caps.features.intune).toMatchObject({ available: true, sku: 'SPE_E3' });
    // The EMS subscription carrying P2 is suspended.
    expect(caps.features.pim).toMatchObject({
      available: false,
      reason: 'Requires Microsoft Entra ID P2 (AAD_PREMIUM_P2)',
      sku: 'AAD_PREMIUM_P2',
    });
    expect(caps.features.defender!.available).toBe(false);
    expect(caps.roles.active).toEqual([
      { id: 'f2ef992c-3afb-46b9-b7cf-a126ee74c451', displayName: 'Global Reader', directoryScopeId: '/' },
    ]);
    expect(caps.roles.activeSource).toBe('assignments');
    expect(caps.roles.eligible).toEqual([]);
    expect(caps.roles.eligibleAvailable).toBe(false);
    expect(caps.errors!.eligible).toMatchObject({
      code: 'licence_required',
      hint: expect.stringContaining('AAD_PREMIUM_P2'),
    });
    expect(caps.skus!.map((s) => s.skuPartNumber)).toEqual(['SPE_E3', 'EMS']);
    await t.app.close();
  });

  it('mock sign-in with live data cannot read Microsoft (refused at startup)', async () => {
    await expect(fixturesApp(env, { DATA_MODE: 'live' })).rejects.toThrow(/DATA_MODE=fixtures/);
  });
});

describe('GET /api/events (SSE)', () => {
  async function open(app: Awaited<ReturnType<typeof fixturesApp>>['app'], cookie: string) {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    const res = await fetch(`${address}/api/events`, { headers: { cookie }, signal: ac.signal });
    const reader = res.body!.getReader();
    let buffer = '';
    const events: Array<{ event: string; data: unknown }> = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buffer += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : undefined });
        }
      }
    })();
    const waitFor = async (pred: () => boolean) => {
      const end = Date.now() + 4000;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out; events so far: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { res, events, waitFor, close: async () => (ac.abort(), await pump) };
  }

  it('streams ready, definitions.changed, run.updated (per user) and session.mode at the end of the write window', async () => {
    const t = await fixturesApp(env);
    // The stream's timers are real, so the clock follows real time — from before sign-in, or the session would look
    // idle-expired whenever real time is over an hour past the fixture clock's start.
    t.clock.t = Date.now();
    const { cookie, csrf } = await mockLogin(t.app);
    // Armed for 0.6 s: the stream reports the switch back to read exactly when the window closes.
    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { armedMinutes: 0.01 },
    });
    const s = await open(t.app, cookie);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    await s.waitFor(() => s.events.length > 0);
    expect(s.events[0]).toMatchObject({ event: 'ready', data: { mode: 'armed' } });

    t.app.ctx.events.publish({ type: 'definitions.changed', data: { keys: ['page:identity.users'] } });
    t.app.ctx.events.publish({
      type: 'run.updated',
      data: { runId: 'r-1', status: 'running' },
      userOid: 'someone-else',
    });
    t.app.ctx.events.publish({
      type: 'run.updated',
      data: { runId: 'r-2', status: 'succeeded' },
      userOid: '00000000-0000-4000-8000-0000000000a1',
    });
    await s.waitFor(() => s.events.some((e) => e.event === 'run.updated'));
    expect(s.events.find((e) => e.event === 'definitions.changed')!.data).toEqual({
      keys: ['page:identity.users'],
    });
    expect(s.events.filter((e) => e.event === 'run.updated').map((e) => e.data)).toEqual([
      { runId: 'r-2', status: 'succeeded' },
    ]);

    // The expiry timer fires ~0.65 s later; by then (fake) time has passed the write window.
    t.clock.advance(5_000);
    await s.waitFor(() => s.events.some((e) => e.event === 'session.mode'));
    expect(s.events.find((e) => e.event === 'session.mode')!.data).toEqual({
      mode: 'read',
      armedUntil: null,
    });
    await s.close();
    await t.app.close();
  });

  it('a content edit on disk reaches the stream (hot reload)', async () => {
    const local = setupContent();
    try {
      const t = await fixturesApp(local, { CONTENT_WATCH: 'true' });
      const { cookie } = await mockLogin(t.app);
      await t.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie } });
      const s = await open(t.app, cookie);
      await s.waitFor(() => s.events.length > 0);
      local.write(
        'pages/identity/new-page.page.yaml',
        'kind: page\nid: identity.new-page\nversion: 1.0.0\ntitle: New\nowner: t\ntemplate: list-detail\nlayout:\n  - { widget: kpi }\n',
      );
      await s.waitFor(() => s.events.some((e) => e.event === 'definitions.changed'));
      expect(s.events.find((e) => e.event === 'definitions.changed')!.data).toEqual({
        keys: ['page:identity.new-page'],
      });
      await s.close();
      await t.app.close();
    } finally {
      local.cleanup();
    }
  });

  it('requires a session', async () => {
    const t = await fixturesApp(env);
    expect((await t.app.inject({ method: 'GET', url: '/api/events' })).statusCode).toBe(401);
    await t.app.close();
  });
});
