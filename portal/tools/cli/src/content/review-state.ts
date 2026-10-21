/**
 * Whether the content directory is exactly what was reviewed — the rule `adminforge publish` enforces before it
 * writes to the database: every file publish reads is committed, and that commit is merged to origin/main.
 *
 * Asks git (local state only — origin/main as last fetched; publish never fetches):
 *   - `rev-parse` for the checkout and HEAD;
 *   - `status --porcelain -z --untracked-files=all --ignored=traditional` under the content directory: modified,
 *     deleted and untracked files count, and so do ignored files publish would read (YAML outside dot-directories,
 *     fixtures/, scripts/ and node_modules — the same set @adminforge/schemas `loadContentDir` reads);
 *   - `merge-base --is-ancestor HEAD origin/main`.
 * Returns the state plus one problem per reason it isn't reviewed; publish prints them, refuses unless
 * --allow-unreviewed, and records the reasons in the audit event. `git` is injectable, so tests run without a repo.
 *
 * In a container image there is no checkout: portal/deploy/kubernetes/build-images.sh checked the same rule when it
 * built the image and recorded the result in BUILD.json at the image's root. That record counts for the image's own
 * content directory only (the image's file system is read-only), never for content somewhere else.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The branch reviewed content is merged to (as last fetched: publish never fetches). */
export const REVIEWED_REF = 'origin/main';

export type UnreviewedReason = 'not-a-git-checkout' | 'dirty' | 'not-on-origin-main';

/** Whether the content directory is exactly what was reviewed: committed, and that commit merged to origin/main. */
export interface ReviewState {
  commit: string | null;
  /** Uncommitted changes (modified, deleted, untracked, or ignored YAML) under the content directory. */
  dirty: boolean | null;
  /** HEAD is contained in origin/main; null when that can't be determined. */
  onOriginMain: boolean | null;
  /** Why the content is not the reviewed state (empty = reviewed). */
  problems: Array<{ reason: UnreviewedReason; message: string }>;
  /** Where the state came from: git, or the image's build record (BUILD.json). */
  source?: 'git' | 'image';
}

/** BUILD.json, written into the image by build-images.sh. */
export interface BuildInfo {
  /** The commit the image was built from. */
  commit: string;
  /** Its content was committed and the commit was on origin/main when the image was built. */
  reviewed: boolean;
  /** The content directory, relative to the image's root (portal/content). */
  contentDir: string;
}

/** The image's build record, when `repoRoot` has one and it is well-formed. */
export function readBuildInfo(repoRoot: string): BuildInfo | null {
  const file = path.join(repoRoot, 'BUILD.json');
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>;
    if (typeof v.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(v.commit)) return null;
    if (typeof v.reviewed !== 'boolean' || typeof v.contentDir !== 'string') return null;
    return { commit: v.commit, reviewed: v.reviewed, contentDir: v.contentDir };
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
    const out = execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
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
 * The review state of `contentDir` from git (local state only: origin/main as last fetched). Ignored files count as
 * uncommitted only when publish would read them.
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
      state.onOriginMain = build.reviewed;
      if (!build.reviewed)
        state.problems.push({
          reason: 'not-on-origin-main',
          message: `This image was built from ${build.commit}, which was not committed and merged to ${REVIEWED_REF} when it was built.`,
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
  if (!state.commit) {
    state.onOriginMain = false;
    state.problems.push({ reason: 'not-on-origin-main', message: 'The checkout has no commit yet.' });
    return state;
  }
  const merged = git(['merge-base', '--is-ancestor', 'HEAD', REVIEWED_REF], contentDir);
  state.onOriginMain = merged.ok ? true : merged.status === 1 ? false : null;
  if (!merged.ok)
    state.problems.push({
      reason: 'not-on-origin-main',
      message:
        merged.status === 1
          ? `HEAD (${state.commit}) is not on ${REVIEWED_REF}: merge it through review first (git fetch to update ${REVIEWED_REF}).`
          : `${REVIEWED_REF} is not known in this checkout (git fetch origin), so HEAD can't be matched to reviewed commits.`,
    });
  return state;
}
