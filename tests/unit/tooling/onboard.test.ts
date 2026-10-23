import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkClaudeSettings,
  checkCommitMessageRule,
  checkEnvFile,
  checkGitHooks,
  checkSkillsAndAgents,
  formatResult,
  frontMatter,
  pinnedNodeMajor,
  pinnedPnpm,
} from '../../../tooling/onboard.mjs';
import { repoRoot } from '../../lib/repo';

// `node tooling/onboard.mjs` (the `onboard` skill): the checks that get a new engineer's checkout ready — pinned Node
// and pnpm, git running .githooks, the commit-message rules, Claude Code's hooks, skills and agents, a private env file —
// with the I/O faked; and the repository itself passes the Claude Code checks.
const ROOT = '/repo';
const fs = (files: Record<string, string>, dirs: Record<string, string[]> = {}) => ({
  exists: (f: string) => f in files || f in dirs,
  read: (f: string) => {
    if (!(f in files)) throw new Error(`ENOENT ${f}`);
    return files[f]!;
  },
  list: (d: string) => dirs[d] ?? [],
});

describe('onboard checks', () => {
  it('reads the pins', () => {
    expect(pinnedNodeMajor('26\n')).toBe(26);
    expect(pinnedNodeMajor('v26.12.1')).toBe(26);
    expect(pinnedNodeMajor('')).toBeNull();
    expect(pinnedPnpm({ packageManager: 'pnpm@11.28.5+sha512.abc' })).toBe('11.28.5');
    expect(pinnedPnpm({})).toBeNull();
  });

  it('reads front matter, folded descriptions too', () => {
    expect(frontMatter('---\nname: onboard\ndescription: >-\n  Use when\n  set up\n---\n# x')).toEqual({
      name: 'onboard',
      description: 'Use when set up',
    });
    expect(frontMatter('# no front matter')).toBeNull();
  });

  it('wants every skill named after its folder, with a description', () => {
    const skills = path.join(ROOT, '.claude/skills');
    const agents = path.join(ROOT, '.claude/agents');
    const good = fs(
      {
        [path.join(skills, 'onboard/SKILL.md')]:
          '---\nname: onboard\ndescription: Use when onboarding\n---\n',
        [path.join(agents, 'security-reviewer.md')]:
          '---\nname: security-reviewer\ndescription: Reviews\n---\n',
      },
      { [skills]: ['onboard'], [agents]: ['security-reviewer.md', 'README.md'] },
    );
    expect(checkSkillsAndAgents(good, ROOT)).toEqual([
      { status: 'ok', name: 'Claude Code skills and agents', detail: '1 skills, 1 reviewer agents' },
    ]);
    const bad = fs(
      { [path.join(skills, 'onboard/SKILL.md')]: '---\nname: onboarding\ndescription: x\n---\n' },
      { [skills]: ['onboard'] },
    );
    expect(checkSkillsAndAgents(bad, ROOT)[0]).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('named "onboarding", not "onboard"'),
    });
  });

  it('wants every Claude Code hook to run a script that exists', () => {
    const settings = path.join(ROOT, '.claude/settings.json');
    const hook = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/after-edit.mjs"' }],
          },
        ],
      },
    };
    const ok = fs({
      [settings]: JSON.stringify(hook),
      [path.join(ROOT, '.claude/hooks/after-edit.mjs')]: '',
    });
    expect(checkClaudeSettings(ok, ROOT)).toMatchObject({ status: 'ok' });
    expect(checkClaudeSettings(fs({ [settings]: JSON.stringify(hook) }), ROOT)).toMatchObject({
      status: 'fail',
      detail: 'missing .claude/hooks/after-edit.mjs',
    });
    expect(checkClaudeSettings(fs({ [settings]: '{' }), ROOT)).toMatchObject({ status: 'fail' });
  });

  it('wants git to run .githooks, executable', () => {
    const io = (hooksPath: string, executable = true) => ({
      git: () => hooksPath,
      exists: () => true,
      executable: () => executable,
    });
    expect(checkGitHooks(io('.githooks\n'), ROOT)).toMatchObject({ status: 'ok' });
    expect(checkGitHooks(io(''), ROOT)).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('core.hooksPath'),
    });
    expect(checkGitHooks(io('.githooks', false), ROOT)).toMatchObject({
      status: 'fail',
      fix: 'chmod +x .githooks/*',
    });
  });

  it('proves the commit-message rule both ways', () => {
    expect(checkCommitMessageRule((m) => m.startsWith('docs:'))).toMatchObject({ status: 'ok' });
    expect(checkCommitMessageRule(() => true)).toMatchObject({
      status: 'fail',
      detail: 'accepts a bad message',
    });
  });

  it('accepts no env file (mock mode), and only a private one', () => {
    const home = '/home/eng';
    const file = path.join(home, '.config/adminforge/dev.env');
    const io = (mode?: number) => ({
      exists: (f: string) => mode !== undefined && f === file,
      mode: () => mode ?? 0,
    });
    expect(checkEnvFile(io(), home)).toMatchObject({ status: 'warn' });
    expect(checkEnvFile(io(0o100600), home)).toMatchObject({ status: 'ok' });
    expect(checkEnvFile(io(0o100644), home)).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('chmod 600'),
    });
  });

  it('prints a fix only for what needs one', () => {
    expect(formatResult({ status: 'ok', name: 'Node.js', detail: '26.12.1', fix: 'x' })).toBe(
      '✓ Node.js — 26.12.1',
    );
    expect(
      formatResult({ status: 'fail', name: 'Git hooks', fix: 'git config core.hooksPath .githooks' }),
    ).toBe('✗ Git hooks\n    → git config core.hooksPath .githooks');
  });
});

describe('this repository', () => {
  const real = {
    exists: (f: string) => existsSync(f),
    read: (f: string) => readFileSync(f, 'utf8'),
    list: (d: string) => readdirSync(d),
  };

  it('passes the Claude Code checks: hooks wired, every skill and agent named', () => {
    expect(checkClaudeSettings(real, repoRoot)).toMatchObject({ status: 'ok' });
    expect(checkSkillsAndAgents(real, repoRoot)).toEqual([expect.objectContaining({ status: 'ok' })]);
  });
});
