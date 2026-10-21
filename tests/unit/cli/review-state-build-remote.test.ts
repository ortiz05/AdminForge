import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContentCliContext } from '@adminforge/cli/src/content/context';
import { publishContent } from '@adminforge/cli/src/commands/publish';
import { readBuildInfo, reviewState, safeRemote, type Git } from '@adminforge/cli/src/content/review-state';
import { repoRoot } from '../../lib/repo';

// Publishing checks the content against origin's main as origin has it now — `git ls-remote` on a checkout, a fresh
// `git fetch origin main` by build-images.sh for an image — never a local origin/main that may be stale or set by
// hand, and fails closed when origin can't be asked (S-06). The commit checked against and origin's URL (without
// credentials) go into BUILD.json and the `content.published` audit event.
const SHA = (c: string) => c.repeat(40);
const noGit: Git = () => ({ ok: false, status: 128 });

const git = (cwd: string, ...args: string[]) =>
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
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  )
    .toString()
    .trim();

/** A checkout with content, and a bare origin it reaches through a URL that carries credentials. */
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'af-review-remote-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const contentDir = path.join(work, 'portal', 'content');
  mkdirSync(contentDir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(contentDir, 'a.page.yaml'), 'kind: page\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'content');
  const url = `file://deploy:s3cret-token@localhost${origin}`;
  git(work, 'remote', 'add', 'origin', url);
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return {
    root,
    origin,
    work,
    contentDir,
    url,
    safeUrl: `file://localhost${origin}`,
    head: () => git(work, 'rev-parse', 'HEAD'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function image(build: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-image-'));
  mkdirSync(path.join(root, 'portal', 'content'), { recursive: true });
  writeFileSync(path.join(root, 'BUILD.json'), JSON.stringify(build));
  return { root, content: path.join(root, 'portal', 'content') };
}

describe('safeRemote', () => {
  it('drops user names, passwords, tokens, queries and fragments', () => {
    expect(safeRemote('https://x-access-token:ghp_secret@github.com/example/adminforge.git')).toBe(
      'https://github.com/example/adminforge.git',
    );
    expect(safeRemote('ssh://git@git.example.com:2222/org/repo.git')).toBe(
      'ssh://git.example.com:2222/org/repo.git',
    );
    expect(safeRemote('git@github.com:example/adminforge.git')).toBe('github.com:example/adminforge.git');
    expect(safeRemote('https://git.example.com/repo.git?private_token=abc#x')).toBe(
      'https://git.example.com/repo.git',
    );
    expect(safeRemote('/srv/git/adminforge.git\n')).toBe('/srv/git/adminforge.git');
  });

  it('refuses what no remote URL needs', () => {
    for (const bad of [
      '',
      '   ',
      'https://host/a b',
      'https://host/"x',
      "https://host/'x",
      'C:\\repo',
      'x\u0007y',
    ])
      expect(safeRemote(bad)).toBeNull();
    expect(safeRemote(`https://host/${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('review state against origin (checkout)', () => {
  it('records the main commit origin has and its URL without credentials', () => {
    const r = repo();
    try {
      const s = reviewState(r.contentDir);
      expect(s).toMatchObject({ onOriginMain: true, problems: [], mainCommit: r.head(), remote: r.safeUrl });
      expect(JSON.stringify(s)).not.toMatch(/s3cret|deploy:/);
    } finally {
      r.cleanup();
    }
  });

  it('a local origin/main set by hand does not make a commit reviewed', () => {
    const r = repo();
    try {
      writeFileSync(path.join(r.contentDir, 'a.page.yaml'), 'kind: page\n# unreviewed\n');
      git(r.work, 'commit', '-q', '-am', 'not reviewed');
      // What the old check trusted: a remote-tracking ref pointing at HEAD, without origin ever seeing it.
      git(r.work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      const s = reviewState(r.contentDir);
      expect(s.onOriginMain).toBe(false);
      expect(s.problems.map((p) => p.reason)).toEqual(['not-on-origin-main']);
      expect(s.mainCommit).not.toBe(r.head());
    } finally {
      r.cleanup();
    }
  });

  it("origin's main moved to a commit this checkout hasn't fetched: unreviewed until a fetch", () => {
    const r = repo();
    try {
      const other = path.join(r.root, 'other');
      git(r.root, 'clone', '-q', '-b', 'main', r.origin, other);
      writeFileSync(path.join(other, 'portal', 'content', 'b.page.yaml'), 'kind: page\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-q', '-m', 'more');
      git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
      const s = reviewState(r.contentDir);
      expect(s.onOriginMain).toBeNull();
      expect(s.mainCommit).toBe(git(other, 'rev-parse', 'HEAD'));
      expect(s.problems[0]!.message).toMatch(/hasn't fetched \(git fetch origin\)/);
      git(r.work, 'fetch', '-q', 'origin');
      expect(reviewState(r.contentDir)).toMatchObject({ onOriginMain: true, problems: [] });
    } finally {
      r.cleanup();
    }
  });

  it('fails closed when origin cannot be reached, has no main, or does not exist', () => {
    const r = repo();
    try {
      git(r.work, 'remote', 'set-url', 'origin', path.join(r.root, 'gone.git'));
      const unreachable = reviewState(r.contentDir);
      expect(unreachable).toMatchObject({ onOriginMain: null, mainCommit: null });
      expect(unreachable.problems).toEqual([
        { reason: 'not-on-origin-main', message: expect.stringMatching(/^origin can't be reached/) },
      ]);

      const empty = path.join(r.root, 'empty.git');
      execFileSync('git', ['init', '-q', '--bare', empty]);
      git(r.work, 'remote', 'set-url', 'origin', empty);
      expect(reviewState(r.contentDir).problems[0]!.message).toMatch(/^origin has no main branch/);

      git(r.work, 'remote', 'remove', 'origin');
      const none = reviewState(r.contentDir);
      expect(none).toMatchObject({ onOriginMain: null, remote: null });
      expect(none.problems[0]!.message).toMatch(/no origin remote/);
    } finally {
      r.cleanup();
    }
  });
});

describe('review state in a container image (BUILD.json)', () => {
  const COMMIT = '0123456789ab';

  it('carries the fetched main commit and the remote, re-checked for credentials', () => {
    const { root, content } = image({
      commit: COMMIT,
      reviewed: true,
      contentDir: 'portal/content',
      mainCommit: SHA('a'),
      remote: 'https://user:token@git.example.com/org/repo.git',
    });
    expect(readBuildInfo(root)).toMatchObject({
      mainCommit: SHA('a'),
      remote: 'https://git.example.com/org/repo.git',
    });
    expect(reviewState(content, noGit, { repoRoot: root })).toEqual({
      commit: COMMIT,
      dirty: false,
      onOriginMain: true,
      mainCommit: SHA('a'),
      remote: 'https://git.example.com/org/repo.git',
      problems: [],
      source: 'image',
    });
  });

  it('a record without the fetched main commit (built before the fetch, or by hand) is not trusted', () => {
    for (const mainCommit of [undefined, '', 'not a sha']) {
      const { root, content } = image({
        commit: COMMIT,
        reviewed: true,
        contentDir: 'portal/content',
        mainCommit,
      });
      const s = reviewState(content, noGit, { repoRoot: root });
      expect(s.onOriginMain).toBeNull();
      expect(s.problems).toEqual([
        { reason: 'not-on-origin-main', message: expect.stringMatching(/rebuild it with build-images\.sh/) },
      ]);
    }
  });
});

describe('build-images.sh', () => {
  /** The script in a copy of the repository's layout (it finds the root from its own path), committed and pushed. */
  function checkout() {
    const r = repo();
    const script = path.join(r.work, 'portal', 'deploy', 'kubernetes', 'build-images.sh');
    mkdirSync(path.dirname(script), { recursive: true });
    copyFileSync(path.join(repoRoot, 'portal', 'deploy', 'kubernetes', 'build-images.sh'), script);
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-q', '-m', 'script');
    git(r.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const run = () => {
      try {
        const out = execFileSync('bash', [script, '--dry-run'], {
          cwd: r.work,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }).toString();
        return { ok: true as const, out };
      } catch (err) {
        const e = err as { status: number; stderr: Buffer };
        return { ok: false as const, status: e.status, err: e.stderr.toString() };
      }
    };
    return { ...r, run };
  }

  it('fetches origin main, then records the fetched commit and the remote without credentials', () => {
    const r = checkout();
    try {
      // A stale local origin/main that would say "not reviewed": the fetch replaces it.
      git(r.work, 'update-ref', '-d', 'refs/remotes/origin/main');
      const res = r.run();
      expect(res.ok).toBe(true);
      const record = JSON.parse((res as { out: string }).out) as Record<string, unknown>;
      expect(record).toEqual({
        commit: r.head().slice(0, 12),
        reviewed: true,
        mainCommit: r.head(),
        remote: r.safeUrl,
        contentDir: 'portal/content',
      });
      expect((res as { out: string }).out).not.toMatch(/s3cret/);
      // What publish in the image reads back from it.
      writeFileSync(path.join(r.root, 'BUILD.json'), (res as { out: string }).out);
      expect(readBuildInfo(r.root)).toMatchObject({
        reviewed: true,
        mainCommit: r.head(),
        remote: r.safeUrl,
      });
    } finally {
      r.cleanup();
    }
  });

  it('records reviewed: false for a commit origin does not have, even with a hand-set origin/main', () => {
    const r = checkout();
    try {
      writeFileSync(path.join(r.contentDir, 'a.page.yaml'), 'kind: page\n# local\n');
      git(r.work, 'commit', '-q', '-am', 'local');
      git(r.work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      const res = r.run();
      expect(res.ok).toBe(true);
      expect(JSON.parse((res as { out: string }).out)).toMatchObject({ reviewed: false });
    } finally {
      r.cleanup();
    }
  });

  it('stops when origin cannot be fetched', () => {
    const r = checkout();
    try {
      git(r.work, 'remote', 'set-url', 'origin', path.join(r.root, 'gone.git'));
      const res = r.run();
      expect(res).toMatchObject({
        ok: false,
        status: 1,
        err: expect.stringMatching(/git fetch origin main failed/),
      });
    } finally {
      r.cleanup();
    }
  });
});

describe('adminforge publish records the review provenance', () => {
  it('the audit event names the content commit, the main commit it was checked against and the remote', async () => {
    const r = repo();
    const audit: Array<Record<string, unknown>> = [];
    try {
      writeFileSync(
        path.join(r.contentDir, 'navigation.yaml'),
        'kind: navigation\nid: portal.navigation\nversion: 1.0.0\ntitle: Navigation\nowner: t\nsections:\n  - { key: identity, label: Identity, icon: identification-card }\n',
      );
      rmSync(path.join(r.contentDir, 'a.page.yaml'));
      git(r.work, 'add', '-A');
      git(r.work, 'commit', '-q', '-m', 'nav');
      git(r.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
      const ctx: ContentCliContext = {
        env: {},
        out: () => undefined,
        repoRoot,
        contentDir: r.contentDir,
        fixturesDir: path.join(r.root, 'fixtures'),
        audit: async (input) => audit.push(input as unknown as Record<string, unknown>),
        openStore: async () => ({
          store: {
            publish: async (entries) => ({
              items: entries.map((e) => ({
                kind: e.def.kind,
                key: e.def.id,
                version: e.def.version,
                status: 'published' as const,
                action: 'create' as const,
              })),
              created: entries.length,
              unchanged: 0,
              refused: 0,
              refreshed: 0,
              applied: true,
              notified: true,
            }),
          },
          close: async () => undefined,
        }),
      };
      await publishContent(ctx);
      expect(audit).toHaveLength(1);
      expect((audit[0]!.details as { git: unknown }).git).toEqual({
        commit: r.head().slice(0, 12),
        dirty: false,
        onOriginMain: true,
        mainCommit: r.head(),
        remote: r.safeUrl,
      });
      expect(JSON.stringify(audit)).not.toMatch(/s3cret/);
    } finally {
      r.cleanup();
    }
  });
});
