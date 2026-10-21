import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCommitMessage, cleanMessage, MAX_HEADER } from '../../../tooling/git/commit-message.mjs';

const SCRIPT = fileURLToPath(new URL('../../../tooling/git/commit-message.mjs', import.meta.url));

describe('commit message convention', () => {
  it.each([
    'feat(api): reports catalogue and in-app report schedules',
    'fix(security,ux): login CSRF binding',
    'docs: engineer onboarding guide',
    'refactor(engine)!: drop the v1 step format',
    'test(e2e): reports catalogue screenshots in both themes',
  ])('accepts "%s"', (header) => {
    expect(checkCommitMessage(header)).toEqual([]);
  });

  it('accepts a body and trailers after a blank line', () => {
    const msg = [
      'fix(scheduler): skip deleted portal schedules',
      '',
      'A run queued before the delete no longer starts.',
      '',
      'Co-Authored-By: Example Engineer <engineer@example.com>',
    ].join('\n');
    expect(checkCommitMessage(msg)).toEqual([]);
  });

  it.each([
    ['Add reports page', /must look like/],
    ['feature(web): add reports page', /Unknown type "feature"/],
    ['feat(website): add reports page', /Unknown scope "website"/],
    ['feat(api, web): add reports page', /Unknown scope/],
    ['feat(): add reports page', /Unknown scope/],
    ['feat(web): add reports page.', /full stop/],
    ['feat(web):  add reports page', /one space/],
    ['feat(web): ', /must look like|empty/],
  ])('refuses "%s"', (header, problem) => {
    expect(checkCommitMessage(header).join(' ')).toMatch(problem);
  });

  it('refuses a header over the limit and a body without the blank line', () => {
    expect(checkCommitMessage(`docs: ${'x'.repeat(MAX_HEADER)}`).join(' ')).toMatch(/characters/);
    expect(checkCommitMessage('docs: guide\nmore text').join(' ')).toMatch(/second line blank/);
  });

  it('lets merge, revert and autosquash commits through locally, but not as a pull request title', () => {
    for (const header of ['Merge branch main', 'Revert "feat(web): x"', 'fixup! feat(web): x']) {
      expect(checkCommitMessage(header)).toEqual([]);
    }
    expect(checkCommitMessage('fixup! feat(web): x', { title: true })).not.toEqual([]);
  });

  it("accepts GitHub's revert title when the reverted header is valid", () => {
    expect(checkCommitMessage('Revert "feat(reports): catalogue"', { title: true })).toEqual([]);
    expect(checkCommitMessage('Revert "updated stuff"', { title: true })).not.toEqual([]);
  });

  it('ignores comment lines and everything below the scissors line (git commit -v)', () => {
    const raw = [
      'fix(api): refuse expired approvals',
      '# Please enter the commit message for your changes.',
      '# ------------------------ >8 ------------------------',
      'diff --git a/x b/x',
    ].join('\n');
    expect(cleanMessage(raw)).toBe('fix(api): refuse expired approvals');
    expect(checkCommitMessage(raw)).toEqual([]);
  });

  it('a pull request title is one line', () => {
    expect(checkCommitMessage('feat(web): reports\nsecond line', { title: true })).toEqual([
      'A pull request title is one line.',
    ]);
  });

  describe('command line (hook and CI)', () => {
    const run = (args: string[]) => {
      try {
        execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' });
        return { code: 0, stderr: '' };
      } catch (err) {
        const e = err as { status: number; stderr: Buffer };
        return { code: e.status, stderr: e.stderr.toString() };
      }
    };

    it('checks a message file and a --title argument', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'af-commit-msg-'));
      try {
        const good = path.join(dir, 'good');
        const bad = path.join(dir, 'bad');
        writeFileSync(good, 'docs: mark the master plan historical\n');
        writeFileSync(bad, 'updated stuff\n');
        expect(run([good]).code).toBe(0);
        const failed = run([bad]);
        expect(failed.code).toBe(1);
        expect(failed.stderr).toContain('10-git-and-pull-requests.md');
        expect(run(['--title', 'feat(reports): catalogue']).code).toBe(0);
        expect(run(['--title', 'WIP']).code).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
