import { randomUUID } from 'node:crypto';
import { parsePlaceholder, replacePlaceholders, resolvePlaceholders } from '../../live/lib/placeholders';

// Live scripts take `@kind:name[#field]` instead of ids, resolved through the portal's own search and read-only
// datasources as the validation user. Synthetic data only.
describe('live placeholders: parsing', () => {
  it('reads kind, name and field, with a default field per kind', () => {
    expect(parsePlaceholder('@user:AF-Test-User-02')).toEqual({
      kind: 'user',
      name: 'AF-Test-User-02',
      field: 'id',
    });
    expect(parsePlaceholder('@mailbox:AF-Test-Shared-01')).toMatchObject({ field: 'mail' });
    expect(parsePlaceholder('@dl:AF-Test-DL-01')).toMatchObject({ kind: 'dl', field: 'mail' });
    expect(parsePlaceholder('@team:AF-Test-Team-01')).toMatchObject({ kind: 'team', field: 'id' });
    expect(parsePlaceholder('@site:AF-Test-Team-01#webUrl')).toEqual({
      kind: 'site',
      name: 'AF-Test-Team-01',
      field: 'webUrl',
    });
  });

  it('leaves everything else alone', () => {
    for (const v of ['AF-Test-User-02', '@unknown:x', 'mail@example.com', '@user:', 42, null, undefined])
      expect(parsePlaceholder(v)).toBeUndefined();
  });

  it('replaces placeholders inside arrays and objects and counts them', async () => {
    const { value, count } = await replacePlaceholders(
      { a: '@user:A', list: ['@group:G', 'literal'], nested: { b: '@dl:D' }, n: 3 },
      async (p) => `<${p.kind}.${p.field}>`,
    );
    expect(value).toEqual({
      a: '<user.id>',
      list: ['<group.id>', 'literal'],
      nested: { b: '<dl.mail>' },
      n: 3,
    });
    expect(count).toBe(3);
  });
});

describe('live placeholders: resolving through the portal', () => {
  const ids = { user: randomUUID(), shared: randomUUID(), dl: randomUUID(), team: randomUUID() };
  const calls: string[] = [];
  const api = async <T>(method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path.replace(/\?.*/, '')}`);
    const json = (() => {
      if (path.startsWith('/api/search')) {
        const q = new URL(path, 'http://x').searchParams;
        const all = [
          { type: 'user', id: ids.user, title: 'AF-Test-User-02', subtitle: 'af-test-user-02@example.com' },
          {
            type: 'user',
            id: ids.shared,
            title: 'AF-Test-Shared-01',
            subtitle: 'af-test-shared-01@example.com',
          },
          { type: 'group', id: ids.dl, title: 'AF-Test-DL-01', subtitle: 'af-test-dl-01@example.com' },
          { type: 'group', id: ids.team, title: 'AF-Test-Team-01', subtitle: 'af-test-team-01@example.com' },
          {
            type: 'group',
            id: randomUUID(),
            title: 'AF-Test-Team-01 archive',
            subtitle: 'other@example.com',
          },
        ];
        return { results: all.filter((r) => r.type === q.get('type') && r.title.includes(q.get('q')!)) };
      }
      if (path === '/api/definitions/page/identity.user') return { version: '1.2.0' };
      if (path === '/api/definitions/page/m365.sharepoint-sites') return { version: '2.0.0' };
      const b = body as { page: string; datasource: string; params: Record<string, string> };
      if (b.page === 'identity.user' && b.datasource === 'profile' && b.params.id === ids.shared)
        return {
          data: { id: ids.shared, displayName: 'AF-Test-Shared-01', mail: 'af-test-shared-01@example.com' },
        };
      if (b.page === 'm365.sharepoint-sites' && b.datasource === 'sites')
        return {
          data: {
            value: [
              {
                id: 'example.sharepoint.com,1,2',
                displayName: 'AF-Test-Team-01',
                webUrl: 'https://example.sharepoint.com/sites/AF-Test-Team-01',
              },
            ],
          },
        };
      return { error: { code: 'not_found' } };
    })();
    return { status: 'error' in json ? 404 : 200, json: json as T };
  };

  it('resolves users, mailboxes, distribution lists, teams and sites to the right fields', async () => {
    const { inputs, count } = await resolvePlaceholders(
      { api },
      {
        userId: '@user:AF-Test-User-02',
        mailbox: '@mailbox:AF-Test-Shared-01',
        identity: '@dl:AF-Test-DL-01',
        teamId: '@team:AF-Test-Team-01',
        siteId: '@site:AF-Test-Team-01',
        siteUrl: '@site:AF-Test-Team-01#webUrl',
        reason: 'Live validation of the placeholders',
      },
    );
    expect(count).toBe(6);
    expect(inputs).toEqual({
      userId: ids.user,
      mailbox: 'af-test-shared-01@example.com',
      identity: 'af-test-dl-01@example.com',
      teamId: ids.team,
      siteId: 'example.sharepoint.com,1,2',
      siteUrl: 'https://example.sharepoint.com/sites/AF-Test-Team-01',
      reason: 'Live validation of the placeholders',
    });
    // The two site placeholders share one lookup.
    expect(calls.filter((c) => c === 'POST /api/datasources/execute')).toHaveLength(2);
  });

  it('fails naming the placeholder as typed, never a resolved value', async () => {
    await expect(resolvePlaceholders({ api }, { m: '@mailbox:AF-Test-Missing' })).rejects.toThrow(
      /^could not resolve @mailbox:AF-Test-Missing: no user named exactly like that/,
    );
    await expect(resolvePlaceholders({ api }, { t: '@team:AF-Test-Team-01#nope' })).rejects.toThrow(
      'could not resolve @team:AF-Test-Team-01#nope: the object has no "nope"',
    );
  });
});
