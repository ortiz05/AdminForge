/**
 * Whether the content directory is exactly what was reviewed — the rule `adminforge publish` enforces before it
 * writes to the database: every file publish reads is committed, and that commit is merged to origin's main branch
 * **as origin has it now**, not as a local `origin/main` last fetched (which can be stale or simply set by hand).
 *
 * Asks git (read-only; publish never fetches or changes a ref):
 *   - `rev-parse` for the checkout and HEAD;
 *   - `status --porcelain -z --untracked-files=all --ignored=traditional` under the content directory: modified,
 *     deleted and untracked files count, and so do ignored files publish would read (YAML outside dot-directories,
 *     fixtures/, scripts/ and node_modules — the same set @adminforge/schemas `loadContentDir` reads);
 *   - `remote get-url origin` (recorded without credentials) and `ls-remote origin refs/heads/main`: the commit main is
 *     at on origin. Origin unreachable, or no main there, fails closed: unreviewed;
 *   - `merge-base --is-ancestor HEAD <that commit>` (a commit this checkout hasn't fetched: unreviewed, fetch first).
 * Returns the state plus one problem per reason it isn't reviewed; publish prints them, refuses unless
 * --allow-unreviewed, and records the reasons, the content commit, the main commit and the remote in the audit event.
 * `git` is injectable, so tests run without a repo.
 *
 * In a container image there is no checkout: portal/deploy/kubernetes/build-images.sh fetched origin's main, checked
 * the same rule when it built the image and recorded the result, the fetched commit and the remote in BUILD.json at
 * the image's root. That record counts for the image's own content directory only (the image's file system is
 * read-only), never for content somewhere else; a record without the fetched commit (an image built before the fetch)
 * is not trusted as reviewed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The branch reviewed content is merged to, as origin has it (`git ls-remote origin refs/heads/main`). */
export const REVIEWED_REF = 'origin/main';
const MAIN_REF = 'refs/heads/main';

export type UnreviewedReason = 'not-a-git-checkout' | 'dirty' | 'not-on-origin-main';

/** Whether the content directory is exactly what was reviewed: committed, and that commit merged to origin/main. */
export interface ReviewState {
  commit: string | null;
  /** Uncommitted changes (modified, deleted, untracked, or ignored YAML) under the content directory. */
  dirty: boolean | null;
  /** HEAD is contained in origin/main; null when that can't be determined. */
  onOriginMain: boolean | null;
  /** The commit origin's main was at when this was checked (full sha); null when origin couldn't say. */
  mainCommit?: string | null;
  /** origin's URL, without credentials (`safeRemote`); null when unknown. */
  remote?: string | null;
  /** Why the content is not the reviewed state (empty = reviewed). */
  problems: Array<{ reason: UnreviewedReason; message: string }>;
  /** Where the state came from: git, or the image's build record (BUILD.json). */
  source?: 'git' | 'image';
}

/** BUILD.json, written into the image by build-images.sh. */
export interface BuildInfo {
  /** The commit the image was built from. */
  commit: string;
  /** Its content was committed and the commit was on origin's main (freshly fetched) when the image was built. */
  reviewed: boolean;
  /** The content directory, relative to the image's root (portal/content). */
  contentDir: string;
  /** The commit origin's main was at, fetched by build-images.sh; null in records from before it fetched. */
  mainCommit: string | null;
  /** origin's URL without credentials; null when not recorded. */
  remote: string | null;
}

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * A git remote URL fit for a record: user name, password or token, query and fragment removed
 * (`https://x:token@host/repo.git` → `https://host/repo.git`, `git@host:org/repo.git` → `host:org/repo.git`); null
 * when it is empty, too long, or has characters no remote URL needs (spaces, quotes, backslashes, control characters).
 * build-images.sh applies the same rules before it writes BUILD.json.
 */
export function safeRemote(url: string | null | undefined): string | null {
  const u = (url ?? '').trim();
  const out = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u)
    ? u.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, '$1').replace(/[?#].*$/s, '')
    : u.replace(/^[^@/]+@/, '');
  if (!out || out.length > 500 || /[\s"'\\\p{Cc}]/u.test(out)) return null;
  return out;
}

/** The image's build record, when `repoRoot` has one and it is well-formed. */
export function readBuildInfo(repoRoot: string): BuildInfo | null {
  const file = path.join(repoRoot, 'BUILD.json');
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<keyof BuildInfo, unknown>>;
    if (typeof v.commit !== 'string' || !SHA.test(v.commit)) return null;
    if (typeof v.reviewed !== 'boolean' || typeof v.contentDir !== 'string') return null;
    return {
      commit: v.commit,
      reviewed: v.reviewed,
      contentDir: v.contentDir,
      mainCommit: typeof v.mainCommit === 'string' && SHA.test(v.mainCommit) ? v.mainCommit : null,
      remote: typeof v.remote === 'string' ? safeRemote(v.remote) : null,
    };
  } catch {
    return null;
  }
}

/** Runs git in `cwd`: stdout, or the exit status when git fails. */
export type Git = (
  args: string[],
  cwd: string,
) => { ok: true; out: string } | { ok: false; status: number | null };

const runGit: Git = (args, cwd) => {
  try {
    // ls-remote reaches origin: never wait on a credential prompt, and give up after a minute (unreviewed).
    const out = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).toString();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, status: (err as { status?: number | null }).status ?? null };
  }
};

/** Files publish reads (loadContentDir): YAML outside dot-directories, fixtures, scripts and node_modules. */
const publishedFile = (file: string) =>
  /\.ya?ml$/.test(file) &&
  !file.split('/').some((s) => s.startsWith('.') || ['node_modules', 'fixtures', 'scripts'].includes(s));

/**
 * The review state of `contentDir` from git, against origin's main as origin has it now (`ls-remote`). Ignored files
 * count as uncommitted only when publish would read them.
 */
export function reviewState(
  contentDir: string,
  git: Git = runGit,
  opts: { repoRoot?: string; buildInfo?: BuildInfo | null } = {},
): ReviewState {
  const state: ReviewState = { commit: null, dirty: null, onOriginMain: null, problems: [], source: 'git' };
  if (!git(['rev-parse', '--show-toplevel'], contentDir).ok) {
    const build = opts.buildInfo ?? (opts.repoRoot ? readBuildInfo(opts.repoRoot) : null);
    if (
      build &&
      opts.repoRoot &&
      path.resolve(contentDir) === path.resolve(opts.repoRoot, build.contentDir)
    ) {
      state.source = 'image';
      state.commit = build.commit;
      state.dirty = false;
      state.mainCommit = build.mainCommit;
      state.remote = build.remote;
      if (!build.mainCommit) {
        // Built before build-images.sh fetched origin's main: its "reviewed" may rest on a stale origin/main.
        state.onOriginMain = null;
        state.problems.push({
          reason: 'not-on-origin-main',
          message: `This image (${build.commit}) doesn't record which ${REVIEWED_REF} commit it was checked against, so its review can't be trusted: rebuild it with build-images.sh.`,
        });
        return state;
      }
      state.onOriginMain = build.reviewed;
      if (!build.reviewed)
        state.problems.push({
          reason: 'not-on-origin-main',
          message: `This image was built from ${build.commit}, which was not committed and merged to ${REVIEWED_REF} (${build.mainCommit.slice(0, 12)}) when it was built.`,
        });
      return state;
    }
    state.problems.push({
      reason: 'not-a-git-checkout',
      message: `${contentDir} is not in a git checkout, so it can't be matched to reviewed commits.`,
    });
    return state;
  }
  const head = git(['rev-parse', '--short=12', 'HEAD'], contentDir);
  state.commit = head.ok ? head.out.trim() : null;
  const status = git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--', '.'],
    contentDir,
  );
  if (status.ok) {
    // `XY path` entries; a rename or copy is followed by its original path as a separate entry.
    const entries = status.out.split('\0');
    const changed: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.length < 4) continue;
      if (/^[RC]|^.[RC]/.test(e)) i++;
      if (!e.startsWith('!! ') || publishedFile(e.slice(3))) changed.push(e.slice(3));
    }
    state.dirty = changed.length > 0;
    if (state.dirty)
      state.problems.push({
        reason: 'dirty',
        message: `${changed.length} uncommitted change(s) under the content directory (git status).`,
      });
  } else {
    state.dirty = true;
    state.problems.push({
      reason: 'dirty',
      message: "git status failed, so uncommitted changes can't be ruled out.",
    });
  }
  const url = git(['remote', 'get-url', 'origin'], contentDir);
  state.remote = url.ok ? safeRemote(url.out) : null;
  state.mainCommit = null;
  if (!state.commit) {
    state.onOriginMain = false;
    state.problems.push({ reason: 'not-on-origin-main', message: 'The checkout has no commit yet.' });
    return state;
  }
  // origin's main as origin has it now: a local origin/main can be stale, or set by hand.
  const listed = url.ok ? git(['ls-remote', 'origin', MAIN_REF], contentDir) : null;
  const main = listed?.ok
    ? listed.out
        .split('\n')
        .map((l) => l.split('\t'))
        .find(([sha, ref]) => ref?.trim() === MAIN_REF && /^[0-9a-f]{40}$/.test(sha ?? ''))?.[0]
    : undefined;
  if (!main) {
    state.onOriginMain = null;
    state.problems.push({
      reason: 'not-on-origin-main',
      message: !url.ok
        ? `This checkout has no origin remote, so HEAD can't be matched to ${REVIEWED_REF}.`
        : listed?.ok
          ? `origin has no main branch (git ls-remote), so HEAD can't be matched to reviewed commits.`
          : `origin can't be reached (git ls-remote origin ${MAIN_REF}), so HEAD can't be matched to ${REVIEWED_REF}: check the network and your access to origin.`,
    });
    return state;
  }
  state.mainCommit = main;
  const merged = git(['merge-base', '--is-ancestor', 'HEAD', main], contentDir);
  state.onOriginMain = merged.ok ? true : merged.status === 1 ? false : null;
  if (!merged.ok)
    state.problems.push({
      reason: 'not-on-origin-main',
      message:
        merged.status === 1
          ? `HEAD (${state.commit}) is not on ${REVIEWED_REF} (${main.slice(0, 12)}): merge it through review first.`
          : `${REVIEWED_REF} is at ${main.slice(0, 12)}, which this checkout hasn't fetched (git fetch origin), so HEAD can't be matched to it.`,
    });
  return state;
}
