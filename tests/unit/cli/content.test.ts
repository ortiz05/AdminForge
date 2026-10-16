import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixtureFetch, createGraphClient } from '@adminforge/connectors';
import { ConfigError } from '@adminforge/cli/src/shared/errors';
import { checkContent } from '@adminforge/cli/src/content/check';
import { contentContext, type ContentCliContext } from '@adminforge/cli/src/content/context';
import { recordFixtures } from '@adminforge/cli/src/commands/fixtures';
import { newDefinition } from '@adminforge/cli/src/commands/new';
import { publishContent } from '@adminforge/cli/src/commands/publish';
import { testContent } from '@adminforge/cli/src/commands/test';
import { validateContent } from '@adminforge/cli/src/commands/validate';
import { Sanitizer } from '@adminforge/cli/src/content/sanitize';
import {
  compareScopes,
  consentedScopes,
  declaredScopes,
  RESOURCE_APP_IDS,
} from '@adminforge/cli/src/content/scopes';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
`;

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'af-cli-'));
  const contentDir = path.join(root, 'content');
  const fixturesDir = path.join(root, 'fixtures');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
  const lines: string[] = [];
  const ctx: ContentCliContext = { env: {}, out: (l) => lines.push(l), repoRoot, contentDir, fixturesDir };
  return {
    root,
    contentDir,
    fixturesDir,
    lines,
    ctx,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const files = (dir: string, base = dir): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) =>
        statSync(path.join(dir, n)).isDirectory()
          ? files(path.join(dir, n), base)
          : [path.relative(base, path.join(dir, n)).split(path.sep).join('/')],
      )
    : [];

describe('adminforge new', () => {
  it('scaffolds every kind and template as content that validates (schema, references, expressions, lint, env keys)', async () => {
    const w = workspace();
    try {
      const made = [
        await newDefinition(w.ctx, 'page', 'identity/stale-groups'),
        await newDefinition(w.ctx, 'page', 'identity/group', { template: 'entity' }),
        await newDefinition(w.ctx, 'page', 'identity/counts', { template: 'dashboard' }),
        await newDefinition(w.ctx, 'page', 'identity/new-groups', { template: 'report' }),
        await newDefinition(w.ctx, 'dashboard', 'identity/overview'),
        await newDefinition(w.ctx, 'report', 'reports/recent-groups'),
        await newDefinition(w.ctx, 'playbook', 'identity/check-sign-in'),
        await newDefinition(w.ctx, 'runbook', 'incident/triage'),
        await newDefinition(w.ctx, 'connection', 'integrations/hr-api'),
        await newDefinition(w.ctx, 'probe', 'probes/graph-org'),
        await newDefinition(w.ctx, 'schedule', 'maintenance/content-health'),
      ];
      const report = await checkContent(w.ctx);
      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.definitions).toBe(12);
      const listPage = readFileSync(made[0]!.file, 'utf8');
      expect(listPage).toMatch(
        /^\$schema: \.\.\/\.\.\/.+\/portal\/packages\/schemas\/generated\/page\.schema\.json$/m,
      );
      expect(listPage).toContain('nav: { section: identity, label: Stale groups, icon: list, order: 100 }');
      expect(made[0]!.file).toBe(path.join(w.contentDir, 'pages/identity/stale-groups.page.yaml'));
      expect(made[5]!.navAdded).toBe(false);
      expect(w.lines).toContain('· no nav: block — section "reports" is not in navigation.yaml.');
      expect(files(w.fixturesDir).sort()).toEqual(
        expect.arrayContaining([
          'graph/v1.0/groups/GET.json',
          'graph/v1.0/groups/00000000-0000-4000-8000-000000000001/GET.json',
          'graph/v1.0/users/$count/GET.json',
          'hosts/func-example.example.com/api/health/GET.json',
        ]),
      );
      // The scaffolded fixture answers the scaffolded page's request in DATA_MODE=fixtures.
      const res = await createFixtureFetch(w.fixturesDir)(
        'https://graph.microsoft.com/v1.0/groups?$select=id&$top=100',
      );
      expect(await res.json()).toEqual({ value: [] });
    } finally {
      w.cleanup();
    }
  });

  it('the scaffolded playbook passes its own tests in the engine', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'playbook', 'identity/check-sign-in');
      w.lines.length = 0;
      expect(await testContent(w.ctx)).toBe(true);
      expect(w.lines).toEqual([
        '✓ identity.check-sign-in › passes for an enabled account',
        '✓ identity.check-sign-in › fails for a disabled account',
        '✓ 2 passed, 0 failed (1 definitions with tests).',
      ]);
    } finally {
      w.cleanup();
    }
  });

  it('refuses existing files (unless --force), bad targets, unknown kinds and templates', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'page', 'identity/x');
      await expect(newDefinition(w.ctx, 'page', 'identity/x')).rejects.toThrow(ConfigError);
      await expect(newDefinition(w.ctx, 'page', 'identity/x', { force: true })).resolves.toBeTruthy();
      await expect(newDefinition(w.ctx, 'page', 'Identity/X')).rejects.toThrow(/kebab/);
      await expect(newDefinition(w.ctx, 'widget', 'identity/y')).rejects.toThrow(/Unknown kind/);
      await expect(newDefinition(w.ctx, 'page', 'identity/y', { template: 'grid' })).rejects.toThrow(
        /Unknown template/,
      );
      await expect(newDefinition(w.ctx, 'playbook', 'identity/z', { template: 'entity' })).rejects.toThrow(
        /--template applies/,
      );
    } finally {
      w.cleanup();
    }
  });
});

describe('adminforge validate', () => {
  it('reports schema, reference, expression, lint and env-key problems with file:line', async () => {
    const w = workspace();
    try {
      writeFileSync(
        path.join(w.contentDir, 'bad.page.yaml'),
        `kind: page
id: identity.bad
version: 1.0.0
title: Bad
owner: t
template: list-detail
nav: { section: nowhere }
params:
  q: { type: string }
datasources:
  users:
    source: graph
    request:
      path: /users
      query:
        $filter: \${ "displayName eq '" & params.q & "'" }
        $top: \${ env.AF_NOT_DECLARED }
        $select: \${ ( }
layout:
  - { widget: kpi, data: users }
`,
      );
      expect(await validateContent(w.ctx)).toBe(false);
      const text = w.lines.join('\n');
      expect(text).toMatch(/✗ bad\.page\.yaml:7 nav\.section: Unknown navigation section "nowhere"/);
      expect(text).toMatch(
        /✗ bad\.page\.yaml:16 datasources\.users\.request\.query\.\$filter: User data is concatenated into \$filter without \$odata\(\)/,
      );
      expect(text).toMatch(/env\.AF_NOT_DECLARED is not declared in config\/example\.env/);
      expect(text).toMatch(/bad\.page\.yaml:18 datasources\.users\.request\.query\.\$select: /);
      expect(w.lines.at(-1)).toMatch(/^✗ 4 problem\(s\)/);
    } finally {
      w.cleanup();
    }
  });

  // Validates the whole content library (hundreds of definitions, growing): sized for a busy parallel run.
  it('checks portal/content with the same loader as the content tests', async () => {
    const ctx = contentContext({}, () => undefined, repoRoot);
    const report = await checkContent(ctx);
    const loaded = await loadContentDir(ctx.contentDir);
    expect(report.definitions).toBe(loaded.definitions.length);
    expect(report.errors.length).toBeGreaterThanOrEqual(loaded.errors.length);
  }, 60_000);

  it('--scopes: missing (declared, not granted) fails; unused is reported; ReadWrite satisfies Read', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups'); // Group.Read.All (Read app)
      await newDefinition(w.ctx, 'probe', 'probes/graph-org'); // Organization.Read.All (automation)
      const ids = {
        read: '00000000-0000-4000-8000-0000000000d1',
        write: '00000000-0000-4000-8000-0000000000d2',
        automation: '00000000-0000-4000-8000-0000000000d3',
      };
      const sp = (appId: string) => `sp-${appId.slice(-2)}`;
      const graphRes = {
        id: 'sp-graph',
        appId: RESOURCE_APP_IDS.graph,
        appRoles: [
          { id: 'role-org', value: 'Organization.Read.All' },
          { id: 'role-dir', value: 'Directory.Read.All' },
        ],
      };
      const fetch: typeof globalThis.fetch = async (input) => {
        const u = new URL(String(input));
        const send = (b: unknown) =>
          new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
        if (u.pathname === '/v1.0/servicePrincipals' && u.searchParams.get('$filter')) {
          const appId = /'(.+)'/.exec(u.searchParams.get('$filter')!)![1]!;
          return send({ value: appId === ids.write ? [] : [{ id: sp(appId), appId }] });
        }
        if (u.pathname === '/v1.0/servicePrincipals/sp-graph') return send(graphRes);
        if (u.pathname === '/v1.0/oauth2PermissionGrants')
          return send({
            value: [
              {
                resourceId: 'sp-graph',
                consentType: 'AllPrincipals',
                scope: 'openid User.Read Group.ReadWrite.All Sites.Read.All',
              },
            ],
          });
        if (u.pathname.endsWith('/appRoleAssignments'))
          return send({ value: [{ resourceId: 'sp-graph', appRoleId: 'role-dir' }] });
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      };
      w.ctx.graph = createGraphClient({ getToken: async () => 't', fetch, maxRetries: 0 });
      w.ctx.env = {
        AF_READ_CLIENT_ID: ids.read,
        AF_WRITE_CLIENT_ID: ids.write,
        AF_AUTOMATION_CLIENT_ID: ids.automation,
      };
      expect(await validateContent(w.ctx, { scopes: true })).toBe(false);
      const text = w.lines.join('\n');
      expect(text).toContain(
        '✗ missing  Automation identity · graph · Organization.Read.All  (probes/probes/graph-org.probe.yaml)',
      );
      expect(text).toContain('· unused   Read app · graph · Sites.Read.All');
      expect(text).toContain('· unused   Automation identity · graph · Directory.Read.All');
      expect(text).toContain('✗ Write app: no service principal found for the configured client id.');
      expect(text).not.toContain('Group.Read.All');
    } finally {
      w.cleanup();
    }
  });

  it('compareScopes / declaredScopes assign content to the right app', async () => {
    const { definitions } = await loadContentDir(path.join(repoRoot, 'portal/content'));
    const declared = declaredScopes(definitions);
    const none = compareScopes(declared, { read: {}, write: {}, automation: {} });
    expect(none.unused).toEqual([]);
    expect(none.missing.some((m) => m.app === 'automation')).toBe(true);
    expect(none.missing.every((m) => m.files?.length)).toBe(true);
    void consentedScopes;
  });
});

describe('adminforge publish', () => {
  it('publishes through the store, prints creates/refusals, and refuses invalid content', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      const published: string[] = [];
      w.ctx.openStore = async () => ({
        store: {
          publish: async (entries, opts) => {
            published.push(
              ...entries.map(
                (e) => `${e.def.kind}:${e.def.id}@${e.def.version}${opts?.dryRun ? ' (dry)' : ''}`,
              ),
            );
            return {
              items: entries.map((e) => ({
                kind: e.def.kind,
                key: e.def.id,
                version: e.def.version,
                status: 'published' as const,
                action: e.def.kind === 'navigation' ? ('unchanged' as const) : ('create' as const),
                file: e.file,
              })),
              created: 1,
              unchanged: 1,
              refreshed: 0,
              refused: 0,
              applied: !opts?.dryRun,
              notified: !opts?.dryRun,
            };
          },
        },
        close: async () => undefined,
      });
      const result = await publishContent(w.ctx, { dryRun: true });
      expect(result!.applied).toBe(false);
      expect(published).toEqual([
        'navigation:portal.navigation@1.0.0 (dry)',
        'page:identity.stale-groups@0.1.0 (dry)',
      ]);
      expect(w.lines).toContain(
        '+ publish  page identity.stale-groups 0.1.0  (pages/identity/stale-groups.page.yaml)',
      );
      expect(w.lines.at(-1)).toBe('✓ would publish: 1 new version(s), 1 unchanged, 0 refused (dry run).');

      writeFileSync(path.join(w.contentDir, 'broken.page.yaml'), 'kind: page\nid: x\n');
      expect(await publishContent(w.ctx)).toBeNull();
      expect(w.lines.at(-1)).toBe('✗ Nothing published: fix the content first (adminforge validate).');
    } finally {
      w.cleanup();
    }
  });
});

// ── fixtures ───────────────────────────────────────────────────────────────────

const TENANT_DOMAIN = 'contoso-test.com';
const TENANT_ID = '9d2f1a77-3b5c-4e8f-9a1b-2c3d4e5f6a7b';

describe('Sanitizer', () => {
  it('replaces names, UPNs, domains, GUIDs, IPs and paging tokens consistently across bodies and URLs', () => {
    const s = new Sanitizer({
      domains: [TENANT_DOMAIN],
      forbidden: [TENANT_ID, TENANT_DOMAIN],
      keepGuids: [RESOURCE_APP_IDS.graph],
    });
    const body = {
      '@odata.nextLink': `https://graph.microsoft.com/v1.0/users?$skiptoken=RFNwdAIAAQAAAB4${TENANT_ID}`,
      value: [
        {
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          displayName: 'Jordan Rivera',
          userPrincipalName: `jordan@${TENANT_DOMAIN}`,
          mail: `jordan@${TENANT_DOMAIN}`,
          department: 'Treasury',
          mobilePhone: '+44 7700 900123',
          appId: RESOURCE_APP_IDS.graph,
        },
        {
          id: 'bbbbbbbb-2222-4222-8222-222222222222',
          displayName: 'Guest Person',
          userPrincipalName: `guest_partner.org#EXT#@contosotest.onmicrosoft.com`,
          lastSignInIp: '203.0.113.77',
          description: `Owner jordan@${TENANT_DOMAIN} in ${TENANT_ID}`,
        },
      ],
    };
    const url = `https://graph.microsoft.com/v1.0/users/aaaaaaaa-1111-4111-8111-111111111111/memberOf?$filter=mail eq 'jordan@${TENANT_DOMAIN}'`;
    s.collectUrl(url);
    s.collect(body, 'User');
    const out = s.apply(body);
    const outUrl = s.url(url);
    const text = JSON.stringify(out) + outUrl;
    expect(text).not.toMatch(/contoso|Jordan|Rivera|Treasury|aaaaaaaa|203\.0\.113|7700/i);
    expect(s.leaks(text)).toEqual([]);
    expect(out.value[0]).toMatchObject({
      displayName: 'Example User 1',
      userPrincipalName: 'user1@example.com',
      mail: 'user1@example.com',
      department: 'Example department 1',
      mobilePhone: '+1 555 0100',
      appId: RESOURCE_APP_IDS.graph,
    });
    expect(out.value[0]!.id).toMatch(/^5ca1ed00-0000-4000-8000-\d{12}$/);
    expect(out.value[1]!.userPrincipalName).toMatch(/^guest\d+#EXT#@exampleorg\.onmicrosoft\.com$/);
    expect(out.value[1]!.lastSignInIp).toMatch(/^192\.0\.2\.\d+$/);
    expect(out['@odata.nextLink']).toBe('https://graph.microsoft.com/v1.0/users?$skiptoken=page2');
    expect(outUrl).toContain(`/users/${out.value[0]!.id}/memberOf`);
    expect(decodeURIComponent(outUrl)).toContain("mail eq 'user1@example.com'");
    expect(s.leaks(`still has ${TENANT_ID}`)).toEqual([0]);
  });
});

describe('adminforge fixtures record', () => {
  it('reads a page as the automation identity, splits $batch, sanitizes, and writes fixtures the fixture fetch serves', async () => {
    const w = workspace();
    try {
      writeFileSync(
        path.join(w.contentDir, 'people.page.yaml'),
        `kind: page
id: identity.people
version: 1.0.0
title: People
owner: t
template: list-detail
datasources:
  users:
    source: graph
    request:
      path: /users
      query: { $select: "id,displayName,userPrincipalName", $top: 2 }
    paging: cursor
  counts:
    source: graphBatch
    requests:
      all: { path: /users/$count, headers: { ConsistencyLevel: eventual } }
      denied: { path: /auditLogs/signIns }
layout:
  - { widget: kpi, data: counts.all }
`,
      );
      const scopes: string[] = [];
      w.ctx.automation = { token: async (scope) => (scopes.push(scope), 'app-token') };
      w.ctx.env = { AF_TENANT_ID: TENANT_ID, AF_PRIMARY_DOMAIN: TENANT_DOMAIN };
      const sent: string[] = [];
      w.ctx.fetch = async (input, init) => {
        const u = String(input);
        sent.push(`${init?.method ?? 'GET'} ${u}`);
        const send = (b: unknown, status = 200) =>
          new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
        if (u.includes('$batch'))
          return send({
            responses: [
              {
                id: 'all',
                status: 200,
                headers: { 'content-type': 'text/plain' },
                body: Buffer.from('2').toString('base64'),
              },
              {
                id: 'denied',
                status: 403,
                body: {
                  error: {
                    code: 'Authentication_RequestFromNonPremiumTenantOrB2CTenant',
                    message: `Tenant ${TENANT_ID} lacks premium`,
                  },
                },
              },
            ],
          });
        return send({
          value: [
            {
              id: 'aaaaaaaa-1111-4111-8111-111111111111',
              displayName: 'Jordan Rivera',
              userPrincipalName: `jordan@${TENANT_DOMAIN}`,
            },
            {
              id: 'bbbbbbbb-2222-4222-8222-222222222222',
              displayName: 'Sam Lee',
              userPrincipalName: `sam@${TENANT_DOMAIN}`,
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=X1Y2Z3',
        });
      };
      expect(await recordFixtures(w.ctx, 'identity.people')).toBe(true);
      expect(scopes).toEqual([
        'https://graph.microsoft.com/.default',
        'https://graph.microsoft.com/.default',
      ]);
      expect(sent.every((s) => !s.startsWith('PATCH') && !s.startsWith('DELETE'))).toBe(true);
      const written = files(w.fixturesDir).sort();
      expect(written).toEqual([
        'graph/v1.0/auditlogs/signins/GET.json',
        'graph/v1.0/users/$count/GET.json',
        'graph/v1.0/users/GET.json',
        'graph/v1.0/users/GET__$select=id,displayname,userprincipalname&$top=2.json',
      ]);
      const all = written.map((f) => readFileSync(path.join(w.fixturesDir, f), 'utf8')).join('\n');
      expect(all).not.toMatch(/contoso|Jordan|Rivera|Sam Lee|aaaaaaaa|X1Y2Z3/i);
      expect(all).not.toContain(TENANT_ID);
      expect(
        JSON.parse(readFileSync(path.join(w.fixturesDir, 'graph/v1.0/auditlogs/signins/GET.json'), 'utf8')),
      ).toMatchObject({ $fixture: { status: 403 } });

      // DATA_MODE=fixtures serves what was recorded, $batch included.
      const ff = createFixtureFetch(w.fixturesDir);
      const users = await (
        await ff('https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName&$top=2')
      ).json();
      expect(users.value.map((u: { displayName: string }) => u.displayName)).toEqual([
        'Example User 1',
        'Example User 2',
      ]);
      expect(users['@odata.nextLink']).toBe('https://graph.microsoft.com/v1.0/users?$skiptoken=page2');
      const batch = await (
        await ff('https://graph.microsoft.com/v1.0/$batch', {
          method: 'POST',
          body: JSON.stringify({ requests: [{ id: '1', method: 'GET', url: '/users/$count' }] }),
        })
      ).json();
      expect(batch.responses[0]).toMatchObject({ id: '1', status: 200 });

      // Existing files are kept unless --force.
      w.lines.length = 0;
      await recordFixtures(w.ctx, 'identity.people', { datasource: 'users' });
      expect(w.lines.some((l) => l.startsWith('· kept'))).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it('needs the automation identity', async () => {
    const w = workspace();
    try {
      w.ctx.automation = null;
      await expect(recordFixtures(w.ctx, 'identity.people')).rejects.toThrow(
        /automation identity is not configured/,
      );
    } finally {
      w.cleanup();
    }
  });
});
