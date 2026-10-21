import { contrastProblems } from '@adminforge/api/src/admin/appearance';
import {
  AdminSettingsResponse,
  ApiErrorBody,
  AppearanceResponse,
  AuditPage,
  AuditVerifyResponse,
} from '@adminforge/schemas';
import { fixturesApp, setupContent, type ContentEnv } from './content-helpers';
import { mockLogin } from './helpers';

let env: ContentEnv;
beforeAll(() => {
  env = setupContent();
});
afterAll(() => env.cleanup());

describe('audit (Portal.Admin)', () => {
  it('lists newest first with filters and a keyset cursor; verifies the chain', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    for (let i = 0; i < 3; i++)
      await t.app.inject({
        method: 'PUT',
        url: '/api/me/prefs',
        headers: { cookie, 'x-adminforge-csrf': csrf },
        payload: { density: i % 2 ? 'compact' : 'comfortable' },
      });
    const all = AuditPage.parse(
      (await t.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).json(),
    );
    expect(all.items[0]!.seq).toBeGreaterThan(all.items.at(-1)!.seq);
    expect(all.items.map((i) => i.action)).toContain('session.signin');

    const page1 = AuditPage.parse(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/audit?action=prefs.updated&limit=1',
          headers: { cookie },
        })
      ).json(),
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.cursor).toBeTruthy();
    const page2 = AuditPage.parse(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/audit?action=prefs.updated&limit=5&cursor=${page1.cursor}`,
          headers: { cookie },
        })
      ).json(),
    );
    expect(page2.items.every((i) => i.seq < page1.items[0]!.seq && i.action === 'prefs.updated')).toBe(true);
    expect(page2.cursor).toBeUndefined();
    const prefix = AuditPage.parse(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/audit?action=session.*&actor=AVERY',
          headers: { cookie },
        })
      ).json(),
    );
    expect(
      prefix.items.every((i) => i.action.startsWith('session.') && i.actorUpn === 'avery@example.com'),
    ).toBe(true);
    expect(
      AuditPage.parse(
        (
          await t.app.inject({ method: 'GET', url: '/api/audit?from=2099-01-01', headers: { cookie } })
        ).json(),
      ).items,
    ).toEqual([]);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/audit?from=yesterday', headers: { cookie } }))
        .statusCode,
    ).toBe(400);

    expect(
      AuditVerifyResponse.parse(
        (await t.app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } })).json(),
      ),
    ).toEqual({ ok: true, checked: t.audit.rows.length });
    t.audit.rows[1]!.action = 'tampered';
    expect(
      AuditVerifyResponse.parse(
        (await t.app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } })).json(),
      ),
    ).toEqual({ ok: false, checked: 1, brokenAt: 2 });

    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { roles: ['Portal.Reader'] },
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).statusCode).toBe(
      403,
    );
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } })).statusCode,
    ).toBe(403);
    await t.app.close();
  });
});

describe('appearance', () => {
  it('admins save allowlisted overrides (contrast-checked, versioned, audited); everyone gets the CSS with an ETag', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const h = { cookie, 'x-adminforge-csrf': csrf };
    expect(
      AppearanceResponse.parse(
        (await t.app.inject({ method: 'GET', url: '/api/admin/appearance', headers: { cookie } })).json(),
      ),
    ).toEqual({ version: 0, overrides: {} });

    const lowContrast = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/appearance',
      headers: h,
      payload: { overrides: { steel: { accent: '#20262B' } } },
    });
    expect(lowContrast.statusCode).toBe(400);
    expect(ApiErrorBody.parse(lowContrast.json()).error).toMatchObject({ code: 'contrast' });
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/admin/appearance',
          headers: h,
          payload: { overrides: { steel: { armed: '#FF0000' } } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/admin/appearance',
          headers: h,
          payload: { overrides: { neon: {} } },
        })
      ).statusCode,
    ).toBe(400);

    const body = {
      overrides: { steel: { accent: '#8FB4F0', 'radius-scale': 1.5 }, daylight: { focus: '#234B86' } },
      density: 'compact',
      fontScale: 1.1,
      version: 0,
    };
    const saved = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/appearance',
      headers: h,
      payload: body,
    });
    expect(saved.statusCode).toBe(200);
    expect(AppearanceResponse.parse(saved.json())).toMatchObject({
      version: 1,
      density: 'compact',
      fontScale: 1.1,
    });
    expect(
      (await t.app.inject({ method: 'PUT', url: '/api/admin/appearance', headers: h, payload: body }))
        .statusCode,
    ).toBe(409);
    expect(t.audit.rows.find((r) => r.action === 'appearance.updated')!.details).toMatchObject({
      version: 1,
      themes: ['steel', 'daylight'],
    });

    const css = await t.app.inject({ method: 'GET', url: '/api/appearance.css', headers: { cookie } });
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers.etag).toBe('"appearance-1"');
    expect(css.body).toContain(
      ':root:not([data-theme]), [data-theme="steel"] {\n  --af-accent: #8FB4F0;\n  --af-radius-sm: calc(3px * 1.5);',
    );
    expect(css.body).toContain('[data-theme="daylight"] {\n  --af-focus: #234B86;');
    expect(css.body).toContain(':root:not([data-density]) {\n  --af-control-h: 28px;');
    expect(css.body).toContain('--af-font-size-md: calc(14px * 1.1);');
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/appearance.css',
          headers: { cookie, 'if-none-match': '"appearance-1"' },
        })
      ).statusCode,
    ).toBe(304);

    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: h,
      payload: { roles: ['Portal.Reader'] },
    });
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/admin/appearance',
          headers: h,
          payload: { overrides: {} },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/appearance.css', headers: { cookie } })).statusCode,
    ).toBe(200);
    await t.app.close();
  });

  it('contrastProblems names the theme, token and ratio', () => {
    expect(contrastProblems({ overrides: { daylight: { accent: '#FFFFFF' } } })[0]).toMatch(
      /^daylight\.accent #FFFFFF has 1\.\d\d:1 against canvas/,
    );
    expect(contrastProblems({ overrides: { contrast: { accent: '#9CCBFF', focus: '#FFFFFF' } } })).toEqual(
      [],
    );
  });
});

describe('GET /api/admin/settings', () => {
  it('summarises the installation for admins only', async () => {
    const t = await fixturesApp(env);
    const { cookie, csrf } = await mockLogin(t.app);
    const res = AdminSettingsResponse.parse(
      (await t.app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } })).json(),
    );
    expect(res).toEqual({
      authMode: 'mock',
      dataMode: 'fixtures',
      contentSource: 'fs',
      writeSessionMaxMinutes: 60,
      writeStepUp: 'none',
      // In-memory audit log without AUDIT_CHAIN_KEY (S-10): unkeyed.
      auditChain: { keyed: false },
      apps: { read: false, write: false, automation: false },
      tenant: { name: 'Example Org', domain: 'example.com' },
    });
    await t.app.inject({
      method: 'POST',
      url: '/auth/mock/state',
      headers: { cookie, 'x-adminforge-csrf': csrf },
      payload: { roles: ['Portal.Reader'] },
    });
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie } })).statusCode,
    ).toBe(403);
    await t.app.close();
  });
});
