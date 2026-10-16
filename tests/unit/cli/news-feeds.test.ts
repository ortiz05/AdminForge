import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixtureFetch } from '@adminforge/connectors';
import { checkContent, newDefinition, type ContentCliContext } from '@adminforge/cli/src/commands/content';
import { ceilingSettings } from '@adminforge/cli/src/commands/context';
import { contentDeclarations } from '@adminforge/cli/src/commands/provision';
import { appFor } from '@adminforge/cli/src/content/scopes';
import { desiredPermissions } from '@adminforge/cli/src/provision/entra-desired';
import { parseDefinition, type Feed } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

// News and changes feeds in the CLI: `adminforge new feed`, `validate --scopes` (feeds run as the automation identity),
// and provisioning, which grants the tenant feeds' application permissions to the automation app from content.

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'af-feed-'));
  const contentDir = path.join(root, 'content');
  const fixturesDir = path.join(root, 'fixtures');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(
    path.join(contentDir, 'navigation.yaml'),
    'kind: navigation\nid: portal.navigation\nversion: 1.0.0\ntitle: Navigation\nowner: t\nsections:\n  - { key: overview, label: Overview, icon: house }\n',
  );
  const lines: string[] = [];
  const ctx: ContentCliContext = { env: {}, out: (l) => lines.push(l), repoRoot, contentDir, fixturesDir };
  return {
    contentDir,
    fixturesDir,
    lines,
    ctx,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('adminforge new feed', () => {
  it('scaffolds a draft RSS feed that validates, with a synthetic fixture for its URL', async () => {
    const w = workspace();
    try {
      const s = await newDefinition(w.ctx, 'feed', 'feeds/example-board');
      expect(s.id).toBe('feeds.example-board');
      // feeds.<name> lives directly in portal/content/feeds (not feeds/feeds/).
      expect(s.file).toBe(path.join(w.contentDir, 'feeds/example-board.feed.yaml'));
      const yaml = readFileSync(s.file, 'utf8');
      expect(yaml).toMatch(/^\$schema: .+\/feed\.schema\.json$/m);
      expect(yaml).toContain('status: draft');
      const parsed = parseDefinition(yaml, 'feeds/example-board.feed.yaml');
      expect(parsed.ok).toBe(true);
      const report = await checkContent(w.ctx);
      expect(report.errors).toEqual([]);
      // The fixture answers the feed's URL in DATA_MODE=fixtures.
      const feed = (parsed.ok ? parsed.def : undefined) as Feed;
      const url = feed.collector.kind === 'rss' ? feed.collector.url : '';
      const res = await createFixtureFetch(w.fixturesDir)(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<rss');
    } finally {
      w.cleanup();
    }
  });

  it('nests feeds of other sections under their section', async () => {
    const w = workspace();
    try {
      const s = await newDefinition(w.ctx, 'feed', 'm365/example-board');
      expect(s.file).toBe(path.join(w.contentDir, 'feeds/m365/example-board.feed.yaml'));
    } finally {
      w.cleanup();
    }
  });
});

describe('feeds and the automation identity', () => {
  it('assigns feed requirements to the automation identity', () => {
    const feed = { kind: 'feed' } as Parameters<typeof appFor>[0];
    expect(appFor(feed)).toBe('automation');
  });

  it('provisioning grants the tenant feeds’ permissions to the automation app, without the sensitive-reads opt-in', async () => {
    const declared = await contentDeclarations(path.join(repoRoot, 'portal/content'));
    const automationGraph = [...(declared.scopes.automation.graph ?? [])];
    expect(automationGraph).toEqual(
      expect.arrayContaining(['ServiceMessage.Read.All', 'ServiceHealth.Read.All']),
    );
    expect(declared.files.get('automation:graph:ServiceMessage.Read.All')).toEqual(
      expect.arrayContaining(['feeds/m365-message-center.feed.yaml']),
    );
    expect(declared.files.get('automation:graph:ServiceHealth.Read.All')).toEqual(
      expect.arrayContaining(['feeds/m365-service-health.feed.yaml']),
    );

    const { requests, withheld } = desiredPermissions(ceilingSettings({}), declared.scopes);
    const granted = requests.automation.filter((r) => r.resource === 'graph').flatMap((r) => r.values);
    expect(granted).toEqual(expect.arrayContaining(['ServiceMessage.Read.All', 'ServiceHealth.Read.All']));
    expect(withheld.map((x) => x.value)).not.toEqual(
      expect.arrayContaining(['ServiceMessage.Read.All', 'ServiceHealth.Read.All']),
    );
  });
});
