import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PublishEntry, PublishResult } from '@adminforge/cli/src/content/api-bridge';
import type { ContentCliContext } from '@adminforge/cli/src/content/context';
import { publishContent } from '@adminforge/cli/src/commands/publish';
import { CONTENT_SCHEMA_VERSION } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

// `adminforge publish --dry-run` says which published rows were written under an older content schema version and
// whether they still pass the current schemas — the rows the API would refuse after an upgrade (D-07).
const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
`;

type Older = NonNullable<PublishResult['olderSchema']>;

function workspace(olderSchema: Older | undefined) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-cli-schema-'));
  const contentDir = path.join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
  const lines: string[] = [];
  const store = {
    publish: async (entries: PublishEntry[], opts?: { dryRun?: boolean }): Promise<PublishResult> => ({
      items: entries.map((e) => ({
        kind: e.def.kind,
        key: e.def.id,
        version: e.def.version,
        status: 'published' as const,
        action: 'unchanged' as const,
      })),
      created: 0,
      unchanged: entries.length,
      refused: 0,
      refreshed: 0,
      applied: !opts?.dryRun,
      notified: false,
      ...(opts?.dryRun && olderSchema ? { olderSchema } : {}),
    }),
  };
  const ctx: ContentCliContext = {
    env: {},
    out: (l) => lines.push(l),
    repoRoot,
    contentDir,
    fixturesDir: path.join(root, 'fixtures'),
    audit: async () => undefined,
    review: () => ({ commit: '0123456789ab', dirty: false, onOriginMain: true, problems: [] }),
    openStore: async () => ({ store, close: async () => undefined }),
  };
  return { ctx, lines, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const row = (key: string, problems: string[] = []): Older[number] => ({
  kind: 'page',
  key,
  version: '1.0.0',
  status: 'published',
  schemaVersion: CONTENT_SCHEMA_VERSION - 1,
  problems,
});

describe('adminforge publish --dry-run: rows from an older content schema', () => {
  it('lists them with what fails under the current schemas', async () => {
    const w = workspace([row('identity.old-users'), row('identity.broken', ['layout: Expected array'])]);
    try {
      await publishContent(w.ctx, { dryRun: true });
      const text = w.lines.join('\n');
      expect(text).toContain(
        `⚠ 2 published version(s) are from an older content schema (current: ${CONTENT_SCHEMA_VERSION}); 1 no longer pass(es) it and would be refused when loaded:`,
      );
      expect(text).toContain(
        `  ✗ page identity.broken 1.0.0 (schema ${CONTENT_SCHEMA_VERSION - 1}) — layout: Expected array`,
      );
      expect(text).toContain(
        `  ⚠ page identity.old-users 1.0.0 (schema ${CONTENT_SCHEMA_VERSION - 1}) — still valid`,
      );
    } finally {
      w.cleanup();
    }
  });

  it('says so when every published row is on the current version', async () => {
    const w = workspace([]);
    try {
      await publishContent(w.ctx, { dryRun: true });
      expect(w.lines).toContain(
        `✓ Every published version is on the current content schema (${CONTENT_SCHEMA_VERSION}).`,
      );
    } finally {
      w.cleanup();
    }
  });

  it('caps a long list', async () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`identity.p${String(i).padStart(2, '0')}`));
    const w = workspace(many);
    try {
      await publishContent(w.ctx, { dryRun: true });
      expect(w.lines.filter((l) => l.startsWith('  ⚠ page identity.p'))).toHaveLength(50);
      expect(w.lines).toContain('  … and 10 more');
    } finally {
      w.cleanup();
    }
  });

  it('a real publish does not list them', async () => {
    const w = workspace([row('identity.old-users')]);
    try {
      await publishContent(w.ctx);
      expect(w.lines.join('\n')).not.toMatch(/older content schema|current content schema/);
    } finally {
      w.cleanup();
    }
  });
});
