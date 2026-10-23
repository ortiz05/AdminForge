import {
  Feed,
  isCitationUrl,
  isFeedUrl,
  jsonSchemas,
  Schedule,
  validateReferences,
  type Definition,
} from '@adminforge/schemas';

// News and changes feeds (news.ts): the fetch allow-list, citation links, classification rules and the requirements a
// tenant feed must declare are all checked when content is validated — not discovered by the hourly job.

const base = {
  kind: 'feed',
  id: 'feeds.example',
  version: '1.0.0',
  title: 'Example',
  owner: 'tests',
  publisher: 'Microsoft',
  homepage: 'https://learn.microsoft.com/en-us/example',
};
const rss = (url: string) => ({ kind: 'rss', url });
const parse = (over: Record<string, unknown>) =>
  Feed.safeParse({
    ...base,
    collector: rss('https://www.microsoft.com/example/rss'),
    keep: 'all',
    defaultAreas: ['platform'],
    ...over,
  });
const messages = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.message));

describe('feed URLs', () => {
  it('fetches only https URLs on the allow-listed hosts', () => {
    expect(isFeedUrl('https://www.microsoft.com/releasecommunications/api/v2/azure/rss')).toBe(true);
    expect(isFeedUrl('https://api.msrc.microsoft.com/update-guide/rss')).toBe(true);
    for (const bad of [
      'http://www.microsoft.com/rss',
      'https://azure.microsoft.com/en-us/updates/feed/',
      'https://msrc.microsoft.com/blog/feed',
      'https://example.com/rss',
      'https://www.microsoft.com.example.com/rss',
      'https://user:pw@www.microsoft.com/rss',
      'https://www.microsoft.com:8443/rss',
      'not a url',
    ])
      expect(isFeedUrl(bad), bad).toBe(false);
    expect(messages(parse({ collector: rss('https://example.com/rss') }))[0]).toMatch(/allowed feed host/);
  });

  it('cites only https links on allowed domains', () => {
    for (const ok of [
      'https://admin.cloud.microsoft/?ref=MessageCenter/:/messages/MC000001',
      'https://app.azure.com/h/EXAMPLE-123/abc123',
      'https://techcommunity.microsoft.com/t5/example/ba-p/1',
      'https://www.powershellgallery.com/packages/Example/1.0.0',
    ])
      expect(isCitationUrl(ok), ok).toBe(true);
    for (const bad of [
      'http://learn.microsoft.com/x',
      'https://evilmicrosoft.com/x',
      'https://microsoft.com.example.com/x',
      'https://eur01.safelinks.protection.outlook.com/?url=x',
      'javascript:alert(1)',
      'https://aka.ms/x',
    ])
      expect(isCitationUrl(bad), bad).toBe(false);
    expect(messages(parse({ homepage: 'https://example.com/' }))[0]).toMatch(/allowed citation domain/);
  });
});

describe('feed rules', () => {
  it('needs a rule with areas for keep: matched, and defaultAreas for keep: all', () => {
    expect(
      messages(parse({ keep: 'matched', classify: [{ match: { title: ['x'] }, kind: 'retirement' }] })),
    ).toEqual(['keep: matched needs at least one rule with areas (otherwise nothing is kept)']);
    expect(messages(parse({ keep: 'all', defaultAreas: [] }))).toEqual([
      'keep: all needs defaultAreas for items no rule places',
    ]);
    expect(
      parse({
        keep: 'matched',
        defaultAreas: [],
        classify: [{ match: { categories: ['x'] }, areas: ['azure'] }],
      }).success,
    ).toBe(true);
  });

  it('refuses empty matches and rules that do nothing', () => {
    expect(messages(parse({ classify: [{ match: {}, areas: ['azure'] }] }))).toContain(
      'Give at least one field to match',
    );
    expect(messages(parse({ classify: [{ match: { title: ['x'] } }] }))).toContain(
      'A rule needs areas, tags, kind, severity, status or exclude: true',
    );
    expect(parse({ classify: [{ match: { title: ['x'] }, status: 'Rolling out' }] }).success).toBe(true);
    expect(messages(parse({ classify: [{ match: { title: ['x'] }, tags: ['Not Kebab'] }] }))[0]).toMatch(
      /kebab/,
    );
  });

  it('bounds polling, excerpts and retention', () => {
    expect(parse({ pollMinutes: 30 }).success).toBe(false);
    expect(parse({ pollMinutes: 2000 }).success).toBe(false);
    expect(parse({ excerptChars: 2000 }).success).toBe(false);
    const ok = parse({});
    expect(ok.success && ok.data).toMatchObject({ pollMinutes: 60, excerptChars: 300, retentionDays: 180 });
  });
});

describe('tenant feeds', () => {
  it('Graph feeds declare their application permissions', () => {
    expect(messages(parse({ collector: { kind: 'messageCenter' } }))[0]).toMatch(/requires\.scopes\.graph/);
    expect(
      parse({
        collector: { kind: 'serviceHealth' },
        requires: { scopes: { graph: ['ServiceHealth.Read.All'] } },
      }).success,
    ).toBe(true);
  });

  it('the Azure Service Health feed declares its Azure role', () => {
    expect(messages(parse({ collector: { kind: 'azureServiceHealth' } }))[0]).toMatch(/azureRoles/);
    expect(
      parse({ collector: { kind: 'azureServiceHealth' }, requires: { azureRoles: ['Reader'] } }).success,
    ).toBe(true);
  });

  it('validates PowerShell Gallery package ids (they go into an OData query)', () => {
    expect(parse({ collector: { kind: 'psGallery', packages: ["x' or 1 eq 1"] } }).success).toBe(false);
    expect(parse({ collector: { kind: 'psGallery', packages: ['PnP.PowerShell'] } }).success).toBe(true);
  });
});

describe('news jobs', () => {
  const schedule = (job: Record<string, unknown>) =>
    Schedule.parse({
      kind: 'schedule',
      id: 'maintenance.news',
      version: '1.0.0',
      title: 'News',
      owner: 'tests',
      cron: '5 * * * *',
      job,
    }) as Definition;
  const feed = Feed.parse({
    ...base,
    collector: rss('https://www.microsoft.com/example/rss'),
    defaultAreas: ['platform'],
  }) as Definition;
  const check = (defs: Definition[]) =>
    validateReferences(defs.map((def, i) => ({ file: `f${i}.yaml`, def }))).map((e) => e.message);

  it('refs must name feeds', () => {
    expect(check([schedule({ kind: 'news', refs: ['feeds.example'] }), feed])).toEqual([]);
    expect(check([schedule({ kind: 'news', refs: ['feeds.missing'] }), feed])).toEqual([
      'Unknown feed "feeds.missing".',
    ]);
  });

  it('a news job without refs needs at least one feed', () => {
    expect(check([schedule({ kind: 'news' })])[0]).toMatch(/No feed is defined/);
    expect(check([schedule({ kind: 'news' }), feed])).toEqual([]);
  });

  it('emits feed.schema.json for editors', () => {
    expect(Object.keys(jsonSchemas())).toContain('feed');
  });
});
