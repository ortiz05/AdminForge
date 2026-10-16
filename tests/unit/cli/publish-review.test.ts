import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  newDefinition,
  publishContent,
  reviewState,
  type ContentCliContext,
  type EngineModule,
  type ReviewState,
} from '@adminforge/cli/src/commands/content';
import { repoRoot } from '../../lib/repo';

// `adminforge publish` runs the same checks as `validate` and `test`, and publishes only reviewed content (committed,
// and the commit merged to origin/main as last fetched) unless --allow-unreviewed, which the audit event records.
const NAV = `kind: navigation
id: portal.navigation
version: 1.0.0
title: Navigation
owner: t
sections:
  - { key: identity, label: Identity, icon: identification-card }
`;

const REVIEWED: ReviewState = { commit: '0123456789ab', dirty: false, onOriginMain: true, problems: [] };

function workspace(opts: { git?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-cli-review-'));
  const contentDir = path.join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(path.join(contentDir, 'navigation.yaml'), NAV);
  const lines: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const published: Array<{ count: number; dryRun: boolean }> = [];
  const ctx: ContentCliContext = {
    env: {},
    out: (l) => lines.push(l),
    repoRoot,
    contentDir,
    fixturesDir: path.join(root, 'fixtures'),
    audit: async (input) => audit.push(input as unknown as Record<string, unknown>),
    openStore: async () => ({
      store: {
        publish: async (entries, o) => {
          published.push({ count: entries.length, dryRun: !!o?.dryRun });
          return {
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
            applied: !o?.dryRun,
            notified: !o?.dryRun,
          };
        },
      },
      close: async () => undefined,
    }),
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Example Dev',
        '-c',
        'user.email=dev@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
  if (opts.git) {
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(root, '.gitignore'), '*.log\nignored/\n');
  }
  /** Commits everything and points origin/main (a local remote-tracking ref, as after a fetch) at it. */
  const commitToOriginMain = () => {
    git('add', '-A');
    git('commit', '-q', '-m', 'content');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  };
  return {
    root,
    contentDir,
    ctx,
    lines,
    audit,
    published,
    git,
    commitToOriginMain,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const reasons = (s: ReviewState) => s.problems.map((p) => p.reason);

describe('reviewState (git)', () => {
  it('refuses a directory outside any git checkout', () => {
    const w = workspace();
    try {
      const s = reviewState(w.contentDir);
      expect(reasons(s)).toEqual(['not-a-git-checkout']);
      expect(s.commit).toBeNull();
    } finally {
      w.cleanup();
    }
  });

  it('accepts committed content whose commit is on origin/main', () => {
    const w = workspace({ git: true });
    try {
      w.commitToOriginMain();
      const s = reviewState(w.contentDir);
      expect(s).toMatchObject({ dirty: false, onOriginMain: true, problems: [] });
      expect(s.commit).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      w.cleanup();
    }
  });

  it('flags modified, deleted and untracked content files', () => {
    const w = workspace({ git: true });
    try {
      w.commitToOriginMain();
      writeFileSync(path.join(w.contentDir, 'navigation.yaml'), `${NAV}# edited\n`);
      expect(reasons(reviewState(w.contentDir))).toEqual(['dirty']);
      w.git('checkout', '-q', '--', '.');
      rmSync(path.join(w.contentDir, 'navigation.yaml'));
      expect(reasons(reviewState(w.contentDir))).toEqual(['dirty']);
      w.git('checkout', '-q', '--', '.');
      writeFileSync(path.join(w.contentDir, 'new.page.yaml'), 'kind: page\n');
      expect(reasons(reviewState(w.contentDir))).toEqual(['dirty']);
    } finally {
      w.cleanup();
    }
  });

  it('counts ignored files only when publish would read them', () => {
    const w = workspace({ git: true });
    try {
      w.commitToOriginMain();
      writeFileSync(path.join(w.contentDir, 'notes.log'), 'x');
      expect(reviewState(w.contentDir).problems).toEqual([]);
      mkdirSync(path.join(w.contentDir, 'ignored'));
      writeFileSync(path.join(w.contentDir, 'ignored', 'hidden.page.yaml'), 'kind: page\n');
      expect(reasons(reviewState(w.contentDir))).toEqual(['dirty']);
    } finally {
      w.cleanup();
    }
  });

  it('ignores changes outside the content directory', () => {
    const w = workspace({ git: true });
    try {
      w.commitToOriginMain();
      writeFileSync(path.join(w.root, 'README.md'), 'elsewhere');
      expect(reviewState(w.contentDir).problems).toEqual([]);
    } finally {
      w.cleanup();
    }
  });

  it('flags a commit that is not on origin/main, and an unknown origin/main', () => {
    const w = workspace({ git: true });
    try {
      w.commitToOriginMain();
      writeFileSync(path.join(w.contentDir, 'navigation.yaml'), `${NAV}# local commit\n`);
      w.git('commit', '-q', '-am', 'unreviewed');
      const local = reviewState(w.contentDir);
      expect(reasons(local)).toEqual(['not-on-origin-main']);
      expect(local.onOriginMain).toBe(false);
      expect(local.problems[0]!.message).toMatch(/is not on origin\/main/);

      w.git('update-ref', '-d', 'refs/remotes/origin/main');
      const unknown = reviewState(w.contentDir);
      expect(reasons(unknown)).toEqual(['not-on-origin-main']);
      expect(unknown.onOriginMain).toBeNull();
      expect(unknown.problems[0]!.message).toMatch(/origin\/main is not known/);
    } finally {
      w.cleanup();
    }
  });

  it('flags a checkout without commits', () => {
    const w = workspace({ git: true });
    try {
      expect(reasons(reviewState(w.contentDir))).toEqual(['dirty', 'not-on-origin-main']);
    } finally {
      w.cleanup();
    }
  });
});

describe('adminforge publish: review gate', () => {
  it('refuses unreviewed content without --allow-unreviewed (nothing opened, nothing audited)', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      expect(await publishContent(w.ctx)).toBeNull();
      expect(w.published).toEqual([]);
      expect(w.audit).toEqual([]);
      expect(w.lines).toContainEqual(expect.stringMatching(/^✗ .* is not in a git checkout/));
      expect(w.lines.at(-1)).toMatch(
        /^✗ Nothing published: publish reviewed content only .*--allow-unreviewed/,
      );
    } finally {
      w.cleanup();
    }
  });

  it('a dry run reports what would be refused and still shows the plan', async () => {
    const w = workspace({ git: true });
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      const result = await publishContent(w.ctx, { dryRun: true });
      expect(result!.applied).toBe(false);
      expect(w.published).toEqual([{ count: 2, dryRun: true }]);
      expect(w.lines).toContain(
        '⚠ A real publish would be refused: commit the content and merge it to origin/main, or pass --allow-unreviewed.',
      );
      expect(w.lines.at(-1)).toMatch(/^✓ would publish: 1 new version/);
      expect(w.audit).toEqual([]);
    } finally {
      w.cleanup();
    }
  });

  it('publishes reviewed content and records the commit', async () => {
    const w = workspace({ git: true });
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      w.commitToOriginMain();
      const result = await publishContent(w.ctx);
      expect(result!.applied).toBe(true);
      expect(w.audit).toHaveLength(1);
      const details = w.audit[0]!.details as Record<string, unknown>;
      expect(details).toMatchObject({
        git: { dirty: false, onOriginMain: true },
        unreviewed: false,
      });
      expect((details.git as { commit: string }).commit).toMatch(/^[0-9a-f]{12}$/);
      expect(details).not.toHaveProperty('reasons');
    } finally {
      w.cleanup();
    }
  });

  it('--allow-unreviewed publishes and records unreviewed: true with the reasons', async () => {
    const w = workspace({ git: true });
    try {
      w.commitToOriginMain();
      w.git('update-ref', 'refs/remotes/origin/main', 'HEAD'); // reviewed so far…
      writeFileSync(path.join(w.contentDir, 'navigation.yaml'), `${NAV}# local commit\n`);
      w.git('commit', '-q', '-am', 'not reviewed'); // …then a local commit…
      await newDefinition(w.ctx, 'page', 'identity/stale-groups'); // …and an uncommitted file
      const result = await publishContent(w.ctx, { allowUnreviewed: true });
      expect(result!.applied).toBe(true);
      expect(w.lines).toContain(
        '⚠ Publishing unreviewed content (--allow-unreviewed): the audit event records it.',
      );
      expect(w.audit).toHaveLength(1);
      expect(w.audit[0]!.details).toMatchObject({
        unreviewed: true,
        reasons: ['dirty', 'not-on-origin-main'],
        git: { dirty: true, onOriginMain: false },
      });
    } finally {
      w.cleanup();
    }
  });

  it('records not-a-git-checkout as the reason outside git', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'page', 'identity/stale-groups');
      await publishContent(w.ctx, { allowUnreviewed: true });
      expect(w.audit[0]!.details).toMatchObject({
        unreviewed: true,
        reasons: ['not-a-git-checkout'],
        git: { commit: null },
      });
    } finally {
      w.cleanup();
    }
  });
});

describe('adminforge publish: the validate and test checks', () => {
  const page = (filter: string, extra = '') => `kind: page
id: identity.bad
version: 1.0.0
title: Bad
owner: t
template: list-detail
params:
  q: { type: string }
datasources:
  users:
    source: graph
    request:
      path: /users
      query:
        $filter: ${filter}${extra}
layout:
  - { widget: kpi, data: users }
`;

  async function refused(w: ReturnType<typeof workspace>, opts = { allowUnreviewed: true }) {
    w.ctx.review = () => REVIEWED;
    expect(await publishContent(w.ctx, opts)).toBeNull();
    expect(w.published).toEqual([]);
    expect(w.audit).toEqual([]);
    return w.lines.join('\n');
  }

  it('refuses content the injection lint flags (even with --allow-unreviewed)', async () => {
    const w = workspace();
    try {
      writeFileSync(
        path.join(w.contentDir, 'bad.page.yaml'),
        page(`"startswith(displayName,'\${ params.q }')"`),
      );
      const text = await refused(w);
      expect(text).toMatch(
        /✗ bad\.page\.yaml:15 datasources\.users\.request\.query\.\$filter: User data is placed in \$filter/,
      );
      expect(w.lines.at(-1)).toBe('✗ Nothing published: fix the content first (adminforge validate).');
    } finally {
      w.cleanup();
    }
  });

  it('refuses expressions that do not compile and undeclared env keys', async () => {
    const w = workspace();
    try {
      writeFileSync(
        path.join(w.contentDir, 'bad.page.yaml'),
        page('${ $odata(params.q) }', '\n        $top: ${ env.AF_NOT_DECLARED }\n        $select: ${ ( }'),
      );
      const text = await refused(w);
      expect(text).toMatch(/env\.AF_NOT_DECLARED is not declared in config\/example\.env/);
      expect(text).toMatch(/bad\.page\.yaml:17 datasources\.users\.request\.query\.\$select: /);
    } finally {
      w.cleanup();
    }
  });

  it('refuses when a playbook test fails', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'playbook', 'identity/reset-thing');
      w.ctx.engine = {
        runPlaybookTests: async () => [
          { name: 'happy path', passed: true, failures: [], status: 'succeeded' },
          { name: 'denied', passed: false, failures: ['expected status failed'], status: 'succeeded' },
        ],
      } satisfies EngineModule;
      const text = await refused(w);
      expect(text).toMatch(/✗ identity\.reset-thing › denied — expected status failed/);
      expect(w.lines.at(-1)).toBe('✗ Nothing published: 1 playbook test(s) failed (adminforge test).');
    } finally {
      w.cleanup();
    }
  });

  it('refuses when the playbook tests cannot run', async () => {
    const w = workspace();
    try {
      w.ctx.engine = null;
      await refused(w);
      expect(w.lines.at(-1)).toMatch(/the playbook engine is not available/);
    } finally {
      w.cleanup();
    }
  });

  it('reports the checks it ran before publishing', async () => {
    const w = workspace();
    try {
      await newDefinition(w.ctx, 'playbook', 'identity/reset-thing');
      w.ctx.review = () => REVIEWED;
      expect(await publishContent(w.ctx)).not.toBeNull();
      expect(w.lines).toContainEqual(
        expect.stringMatching(
          /^✓ 2 definitions valid \(schema, references, expressions, lint, env keys\); [1-9]\d* playbook test\(s\) passed\.$/,
        ),
      );
    } finally {
      w.cleanup();
    }
  });
});
