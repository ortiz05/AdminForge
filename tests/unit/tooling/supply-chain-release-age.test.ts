import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isSeq, parse, parseDocument, type Scalar } from 'yaml';
import { repoRoot } from '../../lib/repo';

// Dependencies wait seven days before they can enter the lockfile (S-04): a compromised upstream release is usually
// found and pulled within days, so neither `pnpm install` nor a Dependabot pull request may pick a version younger
// than that. pnpm enforces it on every resolution (`minimumReleaseAge`, minutes) and re-checks the lockfile against
// it on install; Dependabot waits the same seven days (`cooldown`) — its security updates are exempt by design. An
// urgent fix gets an exclude for that one version (`name@x.y.z`), never for a whole package.
const SEVEN_DAYS_IN_MINUTES = 7 * 24 * 60;

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');
const workspace = parse(read('pnpm-workspace.yaml')) as Record<string, unknown>;
const dependabot = parse(read('.github/dependabot.yml')) as {
  updates: Array<{ 'package-ecosystem': string; directory: string; cooldown?: Record<string, unknown> }>;
};

describe('pnpm: minimum release age', () => {
  it('new versions wait at least seven days', () => {
    expect(workspace.minimumReleaseAge).toBeTypeOf('number');
    expect(workspace.minimumReleaseAge as number).toBeGreaterThanOrEqual(SEVEN_DAYS_IN_MINUTES);
  });

  it('a too-young version fails the install instead of being added to the excludes silently', () => {
    // pnpm defaults to strict once minimumReleaseAge is set; non-strict mode adds immature picks to the excludes.
    expect(workspace.minimumReleaseAgeStrict).toBe(true);
  });

  it('a version without a publish time fails the check instead of skipping it', () => {
    // pnpm 11 defaults minimumReleaseAgeIgnoreMissingTime to true: a mirror without `time` would turn the floor off.
    expect(workspace.minimumReleaseAgeIgnoreMissingTime).toBe(false);
  });

  it('every exclude carries a comment saying why and when it goes', () => {
    const doc = parseDocument(read('pnpm-workspace.yaml'));
    const seq = doc.get('minimumReleaseAgeExclude', true);
    if (seq === undefined) return;
    expect(isSeq(seq)).toBe(true);
    if (!isSeq(seq)) return;
    seq.items.forEach((item, i) => {
      const node = item as Scalar;
      // yaml attaches the comment above the first item to the sequence itself.
      const comment = [node.commentBefore, node.comment, i === 0 ? seq.commentBefore : undefined]
        .join('')
        .trim();
      expect(comment, String(node.value)).not.toBe('');
    });
  });

  it('excludes name one exact version each (an urgent fix), never a package or a name pattern', () => {
    const excludes = (workspace.minimumReleaseAgeExclude ?? []) as unknown[];
    expect(Array.isArray(excludes)).toBe(true);
    for (const entry of excludes) {
      expect(entry, String(entry)).toMatch(
        /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(-[\w.]+)?( \|\| \d+\.\d+\.\d+(-[\w.]+)?)*$/,
      );
    }
  });

  it('the pinned pnpm understands the setting (pnpm 10.16 or later)', () => {
    const pkg = JSON.parse(read('package.json')) as { packageManager: string };
    const m = /^pnpm@(\d+)\.(\d+)\.(\d+)/.exec(pkg.packageManager);
    expect(m, pkg.packageManager).not.toBeNull();
    const [major, minor] = [Number(m![1]), Number(m![2])];
    expect(major > 10 || (major === 10 && minor >= 16)).toBe(true);
  });
});

describe('Dependabot: cooldown and coverage', () => {
  it.each(dependabot.updates.map((u) => [`${u['package-ecosystem']} ${u.directory}`, u] as const))(
    '%s waits at least seven days for new versions',
    (_label, update) => {
      expect(update.cooldown?.['default-days']).toBeTypeOf('number');
      expect(update.cooldown!['default-days'] as number).toBeGreaterThanOrEqual(7);
    },
  );

  it('every Dockerfile in the repository has a docker entry for its directory', () => {
    const dockerDirs = dependabot.updates
      .filter((u) => u['package-ecosystem'] === 'docker')
      .map((u) => u.directory.replace(/\/$/, ''));
    const dockerfiles = execFileSync('git', ['ls-files', '-z', '--', '*Dockerfile'], { cwd: repoRoot })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    expect(dockerfiles.length).toBeGreaterThan(0);
    for (const file of dockerfiles) expect(dockerDirs, file).toContain(`/${path.posix.dirname(file)}`);
  });

  it('npm and GitHub Actions are covered from the repository root', () => {
    const roots = dependabot.updates.filter((u) => u.directory === '/').map((u) => u['package-ecosystem']);
    expect(roots).toEqual(expect.arrayContaining(['npm', 'github-actions']));
  });
});
