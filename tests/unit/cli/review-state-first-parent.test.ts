import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewState } from '@adminforge/cli/src/content/review-state';

// Publish trusts content that was reviewed: a commit that is main on origin (S-06). Reachable from main isn't the same
// thing: a branch merged with a merge commit (or rebased onto main) leaves its intermediate commits reachable,
// although no reviewer approved those states as a whole. Only main's own commits — its first-parent chain — count
// (2026-10-22 security review). Synthetic repository only.
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

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'af-review-first-parent-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const content = path.join(work, 'portal', 'content');
  mkdirSync(content, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(work, 'init', '-q', '-b', 'main');
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(path.join(content, file), text);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  const base = commit('a.page.yaml', 'kind: page\n', 'base');
  git(work, 'checkout', '-q', '-b', 'feature');
  const draft = commit('b.page.yaml', 'kind: page\n# draft nobody approved\n', 'draft');
  const fixed = commit('b.page.yaml', 'kind: page\n', 'after review');
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  const merge = git(work, 'rev-parse', 'HEAD');
  git(work, 'remote', 'add', 'origin', `file://${origin}`);
  git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return { root, work, content, base, draft, fixed, merge };
}

describe('the publish review gate and merged branches', () => {
  const r = repo();
  afterAll(() => rmSync(r.root, { recursive: true, force: true }));
  const at = (sha: string) => {
    git(r.work, 'checkout', '-q', '--detach', sha);
    return reviewState(r.content);
  };

  it('accepts main’s own commits: the merge commit and the commit before it', () => {
    expect(at(r.merge)).toMatchObject({ onOriginMain: true, problems: [] });
    expect(at(r.base)).toMatchObject({ onOriginMain: true, problems: [] });
  });

  it('refuses a commit of the merged branch, though it is reachable from main', () => {
    for (const sha of [r.draft, r.fixed]) {
      expect(git(r.work, 'merge-base', '--is-ancestor', sha, r.merge)).toBe('');
      const state = at(sha);
      expect(state.onOriginMain).toBe(false);
      expect(state.problems).toEqual([
        expect.objectContaining({
          reason: 'not-on-origin-main',
          message: expect.stringMatching(/branch merged into origin\/main/),
        }),
      ]);
    }
  });
});
