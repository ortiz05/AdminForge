import path from 'node:path';
import type { SessionRecord } from '@adminforge/api/src/auth/session-store';
import type { DefinitionRecord, DefinitionRegistry } from '@adminforge/api/src/definitions/types';
import type { OutboundExecutor } from '@adminforge/api/src/execution/types';
import { entityPages, search } from '@adminforge/api/src/search/search';
import { Page, loadContentDir, validateReferences, type Definition } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

// The command palette opens a user, group, device, app or Azure resource on the page that declares `entity:` for
// that kind — no list of page keys in the API (design review D-08). Without one it deep-links to Microsoft's portal.
const page = (key: string, extra: Record<string, unknown> = {}) =>
  ({
    kind: 'page',
    key,
    version: '1.0.0',
    sha256: 'x',
    status: 'published',
    source: 'fs',
    def: {
      kind: 'page',
      id: key,
      version: '1.0.0',
      title: key,
      owner: 'test',
      template: 'entity',
      params: { id: { type: 'guid', required: true } },
      layout: [{ widget: 'keyValue' }],
      ...extra,
    } as unknown as Definition,
  }) as DefinitionRecord;

function registry(records: DefinitionRecord[]): DefinitionRegistry {
  return {
    origin: 'fs',
    list: async (kind?: string) => records.filter((r) => !kind || r.kind === kind),
    get: async (kind: string, key: string) => records.find((r) => r.kind === kind && r.key === key) ?? null,
  } as unknown as DefinitionRegistry;
}

const USER = '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d';
const GROUP = '7c1d9e2a-4b3f-4a5e-8d6c-1e2f3a4b5c6d';
const RESOURCE = '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/x/y/avery';

const outbound = {
  execute: async (_identity: unknown, call: { service: string }) =>
    call.service === 'graph'
      ? {
          data: {
            responses: [
              { id: 'user', status: 200, body: { value: [{ id: USER, displayName: 'Avery Engineer' }] } },
              { id: 'group', status: 200, body: { value: [{ id: GROUP, displayName: 'Avery Fans' }] } },
            ],
          },
        }
      : { data: { value: [{ id: RESOURCE, name: 'avery', type: 'x/y', resourceGroup: 'rg' }] } },
} as unknown as OutboundExecutor;

const session = { roles: ['Portal.Reader'] } as unknown as SessionRecord;

describe('palette entity pages come from content', () => {
  it('maps each declared kind to its page; drafts, other kinds and undeclared pages are left out', async () => {
    const pages = await entityPages(
      registry([
        page('people.person', { entity: 'user' }),
        page('azure.thing', { entity: 'resource' }),
        page('identity.group'), // the old hard-coded key, but it declares nothing
        page('draft.device', { entity: 'device', status: 'draft' }),
        page('retired.app', { entity: 'app', status: 'retired' }),
        { ...page('reports.user', { entity: 'user' }), kind: 'report' } as DefinitionRecord,
      ]),
    );
    expect(pages).toEqual({ user: 'people.person', resource: 'azure.thing' });
  });

  it('two pages declaring one kind: the first key wins, so the result never flips between requests', async () => {
    expect(
      await entityPages(registry([page('b.user', { entity: 'user' }), page('a.user', { entity: 'user' })])),
    ).toEqual({ user: 'a.user' });
  });

  it('search links results to the declared pages, and to the Microsoft portal for the rest', async () => {
    const res = await search(
      {
        definitions: registry([
          page('people.person', { entity: 'user' }),
          page('azure.thing', { entity: 'resource' }),
        ]),
        outbound,
        timeoutMs: 1000,
      },
      session,
      'avery',
    );
    const byType = (t: string) => res.results.find((r) => r.type === t)!;
    expect(byType('user')).toMatchObject({ href: `/p/people.person?id=${USER}` });
    expect(byType('user').external).toBeUndefined();
    expect(byType('group')).toMatchObject({
      external: true,
      href: expect.stringMatching(/^https:\/\/entra\.microsoft\.com\/.*groupId\//),
    });
    expect(byType('resource')).toMatchObject({ href: `/p/azure.thing?id=${encodeURIComponent(RESOURCE)}` });
  });

  it('a page that declares an entity takes its id', () => {
    const base = {
      kind: 'page',
      id: 'people.person',
      version: '1.0.0',
      title: 'Person',
      owner: 'test',
      template: 'entity',
      entity: 'user',
      layout: [{ widget: 'keyValue', data: 'x' }],
    };
    const r = Page.safeParse(base);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['entity', expect.stringMatching(/declare an `id` param/)],
    ]);
    expect(Page.safeParse({ ...base, params: { id: { type: 'guid', required: true } } }).success).toBe(true);
    expect(Page.safeParse({ ...base, entity: 'printer' }).success).toBe(false);
    // The palette doesn't search subscriptions, so no page can claim them.
    expect(Page.safeParse({ ...base, entity: 'subscription' }).success).toBe(false);
  });

  it('validate refuses a second page declaring a kind, so publishing never changes where results open', () => {
    const entry = (key: string, extra: Record<string, unknown> = {}) => ({
      file: `pages/${key}.page.yaml`,
      def: page(key, extra).def,
    });
    const errors = validateReferences([
      entry('identity.person', { entity: 'user' }),
      entry('identity.a-lookup', { entity: 'user' }),
      entry('old.person', { entity: 'user', status: 'retired' }),
    ]);
    expect(errors.filter((e) => e.path === 'entity')).toEqual([
      expect.objectContaining({
        file: 'pages/identity.a-lookup.page.yaml',
        message: expect.stringMatching(/"identity.person" .* already declares entity: user/),
      }),
    ]);
  });

  /**
   * identity.user is another review package's file in this wave: it declares `entity: user` when that merges (until
   * then the palette links users to Entra). Remove `user` here once it does — the test then holds it.
   */
  const PENDING = new Set(['user']);

  it('portal/content declares one page per kind, each taking the object id', async () => {
    const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
    const declared = loaded.definitions
      .filter((d) => d.def.kind === 'page' && (d.def as { entity?: string }).entity)
      .map((d) => ({ kind: (d.def as { entity: string }).entity, key: d.def.id }));
    const kinds = declared.map((d) => d.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    const expected: Record<string, string> = {
      user: 'identity.user',
      group: 'identity.group',
      device: 'identity.device',
      app: 'identity.app-registration',
      resource: 'azure.resource',
    };
    const byKind = Object.fromEntries(declared.map((d) => [d.kind, d.key]));
    for (const [kind, key] of Object.entries(expected))
      expect([kind, byKind[kind]]).toEqual([kind, PENDING.has(kind) ? undefined : key]);
  });
});
