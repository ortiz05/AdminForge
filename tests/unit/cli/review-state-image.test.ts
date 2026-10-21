import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readBuildInfo, reviewState, type Git } from '@adminforge/cli/src/content/review-state';

// `adminforge publish` inside the pod has no git checkout: the image's BUILD.json (written by build-images.sh, which
// checked the review rule when it built the image) stands in — for the image's own content directory only.
const noGit: Git = () => ({ ok: false, status: 128 });
const COMMIT = '0123456789ab';

function image(build?: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), 'af-image-'));
  mkdirSync(path.join(root, 'portal', 'content'), { recursive: true });
  if (build !== undefined) writeFileSync(path.join(root, 'BUILD.json'), JSON.stringify(build));
  return { root, content: path.join(root, 'portal', 'content') };
}

describe('review state in a container image', () => {
  it('an image built from reviewed content publishes like a reviewed checkout', () => {
    const { root, content } = image({ commit: COMMIT, reviewed: true, contentDir: 'portal/content' });
    expect(reviewState(content, noGit, { repoRoot: root })).toEqual({
      commit: COMMIT,
      dirty: false,
      onOriginMain: true,
      problems: [],
      source: 'image',
    });
  });

  it('an image built from unreviewed content needs --allow-unreviewed, and says which commit', () => {
    const { root, content } = image({ commit: COMMIT, reviewed: false, contentDir: 'portal/content' });
    const s = reviewState(content, noGit, { repoRoot: root });
    expect(s.problems).toEqual([
      {
        reason: 'not-on-origin-main',
        message: `This image was built from ${COMMIT}, which was not committed and merged to origin/main when it was built.`,
      },
    ]);
    expect(s.onOriginMain).toBe(false);
  });

  it("the record counts for the image's own content only — content anywhere else is not a checkout", () => {
    const { root } = image({ commit: COMMIT, reviewed: true, contentDir: 'portal/content' });
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'af-other-'));
    expect(reviewState(elsewhere, noGit, { repoRoot: root }).problems.map((p) => p.reason)).toEqual([
      'not-a-git-checkout',
    ]);
  });

  it('ignores a missing or malformed record', () => {
    expect(readBuildInfo(image().root)).toBeNull();
    for (const bad of [
      { commit: 'not hex', reviewed: true, contentDir: 'x' },
      { commit: COMMIT, reviewed: 'yes' },
      'junk',
    ])
      expect(readBuildInfo(image(bad).root)).toBeNull();
    const { content } = image({ commit: COMMIT, reviewed: true, contentDir: 'portal/content' });
    // Without repoRoot nothing is read: a plain non-checkout.
    expect(reviewState(content, noGit).problems.map((p) => p.reason)).toEqual(['not-a-git-checkout']);
  });
});
