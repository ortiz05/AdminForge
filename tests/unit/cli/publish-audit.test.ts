import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContentCliContext } from '@adminforge/cli/src/content/context';
import { newDefinition } from '@adminforge/cli/src/commands/new';
import { publishContent } from '@adminforge/cli/src/commands/publish';
import { repoRoot } from '../../lib/repo';

// Publishing changes what the portal can do, so it is recorded in the audit chain: who, which versions, which commit.
const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
`;

function workspace(audit: Array<Record<string, unknown>>) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-cli-audit-'));
  const contentDir = path.join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
  const ctx: ContentCliContext = {
    env: {},
    out: () => undefined,
    repoRoot,
    contentDir,
    fixturesDir: path.join(root, 'fixtures'),
    audit: async (input) => audit.push(input as unknown as Record<string, unknown>),
    // Reviewed content (publish-review.test.ts covers the git checks themselves).
    review: () => ({ commit: '0123456789ab', dirty: false, onOriginMain: true, problems: [] }),
    openStore: async () => ({
      store: {
        publish: async (entries, opts) => ({
          items: entries.map((e) => ({
            kind: e.def.kind,
            key: e.def.id,
            version: e.def.version,
            status: 'published' as const,
            action: e.def.kind === 'navigation' ? ('unchanged' as const) : ('create' as const),
            file: e.file,
          })),
          created: entries.length - 1,
          unchanged: 1,
          refreshed: 0,
          refused: 0,
          applied: !opts?.dryRun,
          notified: !opts?.dryRun,
        }),
      },
      close: async () => undefined,
    }),
  };
  return { ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('adminforge publish → audit', () => {
  it('records the published versions, the publisher and the git commit', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const w = workspace(audit);
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      await publishContent(w.ctx);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'content.published',
        actorOid: 'cli',
        mode: 'write',
        result: 'success',
        details: { versions: ['page:identity.stale-groups@0.1.0'], refused: 0 },
      });
      expect(String(audit[0]!.actorUpn)).toMatch(/@/);
      expect((audit[0]!.details as { git: { commit: string | null } }).git.commit).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      w.cleanup();
    }
  });

  it('a dry run records nothing', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const w = workspace(audit);
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      await publishContent(w.ctx, { dryRun: true });
      expect(audit).toHaveLength(0);
    } finally {
      w.cleanup();
    }
  });
});
