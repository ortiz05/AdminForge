#!/usr/bin/env node
/**
 * `node tooling/onboard.mjs` (or `pnpm onboard`; in Claude Code say "onboard"): gets a new engineer's checkout ready
 * and proves it — the pinned Node and pnpm, the workspace installed, git running the same hooks as CI, the generated
 * schemas and design tokens built, Chrome for Playwright, and Claude Code's project setup (the after-edit hook, the
 * skills and the reviewer agents) in place — then runs the guard tests. Built-ins only, so it runs before
 * `pnpm install`. Never prints a configuration value.
 *
 *   node tooling/onboard.mjs            install what's missing, then check everything
 *   node tooling/onboard.mjs --check    check only: change nothing (CI, or "is my machine still right?")
 *   node tooling/onboard.mjs --quick    skip the guard tests at the end
 *
 * The checks are pure exported functions with the I/O injected (`deps`), so tests/unit/tooling/onboard.test.ts can run
 * them against fakes; running the file directly is the command. Exit 1 when a required check fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {{ status: 'ok' | 'fixed' | 'warn' | 'fail', name: string, detail?: string, fix?: string }} Result */

/** `fn()`, or null when it throws (a missing command, a git setting that isn't set). */
const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** The major version `.nvmrc` pins ("26" or "v26.1.0" → 26), or null. */
export function pinnedNodeMajor(nvmrc) {
  const m = /^\s*v?(\d+)/.exec(nvmrc ?? '');
  return m ? Number(m[1]) : null;
}

/** The pnpm version `packageManager` pins ("pnpm@11.28.5+sha512…" → "11.28.5"), or null. */
export function pinnedPnpm(packageJson) {
  const m = /^pnpm@(\d+\.\d+\.\d+)/.exec(packageJson?.packageManager ?? '');
  return m ? m[1] : null;
}

/**
 * Front matter of a Markdown file: `name:` and `description:` (single line or a `>`/`|` block), or null without one.
 * @param {string} text
 */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Every project skill (`.claude/skills/<name>/SKILL.md`) and reviewer agent (`.claude/agents/<name>.md`) has front
 * matter with a `name` matching its folder or file and a `description` — what Claude Code needs to offer it.
 * @param {{ list: (dir: string) => string[], read: (file: string) => string, exists: (file: string) => boolean }} io
 * @returns {Result[]}
 */
export function checkSkillsAndAgents(io, root = REPO_ROOT) {
  const problems = [];
  const skillsDir = path.join(root, '.claude/skills');
  const agentsDir = path.join(root, '.claude/agents');
  const skills = io.exists(skillsDir)
    ? io.list(skillsDir).filter((d) => io.exists(path.join(skillsDir, d, 'SKILL.md')))
    : [];
  for (const s of skills) {
    const fm = frontMatter(io.read(path.join(skillsDir, s, 'SKILL.md')));
    if (!fm?.name || !fm.description)
      problems.push(`.claude/skills/${s}/SKILL.md has no name or description`);
    else if (fm.name !== s) problems.push(`.claude/skills/${s}/SKILL.md is named "${fm.name}", not "${s}"`);
  }
  const agents = io.exists(agentsDir)
    ? io.list(agentsDir).filter((f) => f.endsWith('.md') && f !== 'README.md')
    : [];
  for (const a of agents) {
    const fm = frontMatter(io.read(path.join(agentsDir, a)));
    if (!fm?.name || !fm.description) problems.push(`.claude/agents/${a} has no name or description`);
  }
  const results = [];
  results.push(
    problems.length
      ? {
          status: 'fail',
          name: 'Claude Code skills and agents',
          detail: problems.join('; '),
          fix: 'Fix the front matter (name: <folder>, description: when to use it).',
        }
      : skills.length === 0
        ? {
            status: 'fail',
            name: 'Claude Code skills',
            detail: 'none found in .claude/skills',
            fix: 'Check out the whole repository.',
          }
        : {
            status: 'ok',
            name: 'Claude Code skills and agents',
            detail: `${skills.length} skills, ${agents.length} reviewer agents`,
          },
  );
  return results;
}

/**
 * `.claude/settings.json` parses, and every hook it wires runs a script that exists (`$CLAUDE_PROJECT_DIR/…`).
 * @param {{ read: (file: string) => string, exists: (file: string) => boolean }} io
 * @returns {Result}
 */
export function checkClaudeSettings(io, root = REPO_ROOT) {
  const file = path.join(root, '.claude/settings.json');
  if (!io.exists(file))
    return {
      status: 'fail',
      name: 'Claude Code project settings',
      detail: '.claude/settings.json is missing',
      fix: 'Check out the whole repository.',
    };
  let settings;
  try {
    settings = JSON.parse(io.read(file));
  } catch {
    return {
      status: 'fail',
      name: 'Claude Code project settings',
      detail: '.claude/settings.json is not valid JSON',
    };
  }
  const commands = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((m) => m?.hooks ?? [])
    .map((h) => h?.command)
    .filter((c) => typeof c === 'string');
  if (!commands.length)
    return {
      status: 'fail',
      name: 'Claude Code hooks',
      detail: 'no hooks in .claude/settings.json',
      fix: 'Restore the PostToolUse after-edit hook.',
    };
  const missing = commands
    .flatMap((c) => [...c.matchAll(/\$CLAUDE_PROJECT_DIR\/([^"'\s]+)/g)].map((m) => m[1]))
    .filter((rel) => !io.exists(path.join(root, rel)));
  return missing.length
    ? { status: 'fail', name: 'Claude Code hooks', detail: `missing ${missing.join(', ')}` }
    : {
        status: 'ok',
        name: 'Claude Code hooks',
        detail: `${commands.length} wired in .claude/settings.json`,
      };
}

/**
 * git runs the repository's hooks (`core.hooksPath = .githooks`) and both are executable.
 * @param {{ git: (...args: string[]) => string, exists: (file: string) => boolean, executable: (file: string) => boolean }} io
 * @returns {Result}
 */
export function checkGitHooks(io, root = REPO_ROOT) {
  const hooksPath = attempt(() => io.git('config', 'core.hooksPath').trim()) ?? '';
  if (hooksPath !== '.githooks')
    return {
      status: 'fail',
      name: 'Git hooks',
      detail: hooksPath ? `core.hooksPath is ${hooksPath}` : 'core.hooksPath is not set',
      fix: 'git config core.hooksPath .githooks (pnpm install sets it)',
    };
  const notExecutable = ['pre-commit', 'commit-msg'].filter((h) => {
    const f = path.join(root, '.githooks', h);
    return !io.exists(f) || !io.executable(f);
  });
  return notExecutable.length
    ? {
        status: 'fail',
        name: 'Git hooks',
        detail: `not executable: ${notExecutable.join(', ')}`,
        fix: 'chmod +x .githooks/*',
      }
    : {
        status: 'ok',
        name: 'Git hooks',
        detail: 'pre-commit (guard tests) and commit-msg run on every commit',
      };
}

/**
 * The commit-msg check accepts a good message and refuses a bad one (the hook really runs the rules).
 * @param {(message: string) => boolean} accepts
 * @returns {Result}
 */
export function checkCommitMessageRule(accepts) {
  const good = accepts('docs: onboarding check message');
  const bad = accepts('fixed stuff.');
  return good && !bad
    ? { status: 'ok', name: 'Commit message check', detail: 'accepts docs: …, refuses "fixed stuff."' }
    : {
        status: 'fail',
        name: 'Commit message check',
        detail: good ? 'accepts a bad message' : 'refuses a good message',
        fix: 'node tooling/git/commit-message.mjs <file> should run; see docs/onboarding/10-git-and-pull-requests.md',
      };
}

/** Google Chrome where Playwright's `channel: 'chrome'` looks for it. */
export const CHROME_PATHS = {
  linux: ['/opt/google/chrome/chrome'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [
    `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

/** The env file a tenant checkout reads: optional (mock mode needs none), but private when it exists. */
export function checkEnvFile(io, home = os.homedir()) {
  const file = path.join(home, '.config/adminforge/dev.env');
  if (!io.exists(file))
    return {
      status: 'warn',
      name: 'Env file (optional)',
      detail: 'none — mock mode needs none',
      fix: 'For a tenant: docs/onboarding/01-setup.md › Give yourself a local database',
    };
  const mode = io.mode(file) & 0o777;
  return mode & 0o077
    ? {
        status: 'fail',
        name: 'Env file',
        detail: `~/.config/adminforge/dev.env is readable by others (mode ${mode.toString(8)})`,
        fix: 'chmod 600 ~/.config/adminforge/dev.env',
      }
    : { status: 'ok', name: 'Env file', detail: '~/.config/adminforge/dev.env, mode 600 (values not read)' };
}

const MARK = { ok: '✓', fixed: '✓', warn: '!', fail: '✗' };
export function formatResult(r) {
  const head = `${MARK[r.status]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}${r.status === 'fixed' ? ' (set up now)' : ''}`;
  return r.fix && (r.status === 'fail' || r.status === 'warn') ? `${head}\n    → ${r.fix}` : head;
}

// ── The command ──────────────────────────────────────────────────────────────────────────────────────────────────────

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}
function step(title, args) {
  process.stdout.write(`  … ${title}\n`);
  const r = spawnSync('corepack', ['pnpm', ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
  return r.status === 0;
}

async function main(argv) {
  const check = argv.includes('--check');
  const quick = argv.includes('--quick');
  const results = [];
  const add = (r) => {
    results.push(r);
    console.log(formatResult(r));
  };
  console.log(`AdminForge onboarding${check ? ' (check only)' : ''}\n`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const wantNode = pinnedNodeMajor(readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8'));
  add(
    nodeMajor === wantNode
      ? { status: 'ok', name: 'Node.js', detail: `${process.versions.node} (.nvmrc ${wantNode})` }
      : {
          status: 'fail',
          name: 'Node.js',
          detail: `${process.versions.node}, .nvmrc wants ${wantNode}`,
          fix: 'nvm install && nvm use (or fnm use), then run this again',
        },
  );

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const wantPnpm = pinnedPnpm(pkg);
  const pnpmVersion = attempt(() =>
    sh('corepack', ['pnpm', '--version'], {
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    }).trim(),
  );
  add(
    pnpmVersion === wantPnpm
      ? { status: 'ok', name: 'pnpm (Corepack)', detail: pnpmVersion }
      : {
          status: 'fail',
          name: 'pnpm (Corepack)',
          detail: pnpmVersion
            ? `${pnpmVersion}, packageManager wants ${wantPnpm}`
            : 'Corepack is not installed',
          fix: 'npm install --global --ignore-scripts corepack@0.36.0 && corepack enable',
        },
  );
  if (results.some((r) => r.status === 'fail')) return finish(results);

  const installed = existsSync(path.join(REPO_ROOT, 'node_modules/.modules.yaml'));
  if (!check) {
    const ok = step('pnpm install --frozen-lockfile (also points git at .githooks)', [
      'install',
      '--frozen-lockfile',
    ]);
    add(
      ok
        ? { status: installed ? 'ok' : 'fixed', name: 'Workspace installed' }
        : { status: 'fail', name: 'Workspace installed', detail: 'pnpm install failed (see above)' },
    );
  } else
    add(
      installed
        ? { status: 'ok', name: 'Workspace installed' }
        : {
            status: 'fail',
            name: 'Workspace installed',
            detail: 'node_modules is missing',
            fix: 'node tooling/onboard.mjs (without --check)',
          },
    );

  const io = {
    list: (d) => readdirSync(d),
    read: (f) => readFileSync(f, 'utf8'),
    exists: (f) => existsSync(f),
    executable: (f) => (statSync(f).mode & 0o111) !== 0,
    mode: (f) => statSync(f).mode,
    git: (...args) => sh('git', args),
  };
  let hooks = checkGitHooks(io);
  if (hooks.status === 'fail' && !check && hooks.detail?.startsWith('core.hooksPath')) {
    sh('git', ['config', 'core.hooksPath', '.githooks']);
    hooks = { ...checkGitHooks(io), status: checkGitHooks(io).status === 'ok' ? 'fixed' : 'fail' };
  }
  add(hooks);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'adminforge-onboard-'));
  try {
    add(
      checkCommitMessageRule((message) => {
        const file = path.join(tmp, 'COMMIT_EDITMSG');
        writeFileSync(file, `${message}\n`);
        return (
          spawnSync(process.execPath, [path.join(REPO_ROOT, 'tooling/git/commit-message.mjs'), file], {
            stdio: 'ignore',
          }).status === 0
        );
      }),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const generated = [
    {
      name: 'Content JSON schemas',
      file: 'portal/packages/schemas/generated/page.schema.json',
      build: ['--filter', '@adminforge/schemas', 'build'],
    },
    {
      name: 'Design tokens',
      file: 'portal/packages/design-tokens/dist/tokens.css',
      build: ['--filter', '@adminforge/design-tokens', 'build'],
    },
  ];
  for (const g of generated) {
    const file = path.join(REPO_ROOT, g.file);
    let built = existsSync(file);
    // Not there and allowed to change things: build it, then look again.
    const fixed = !built && !check && step(`building ${g.name.toLowerCase()}`, g.build) && existsSync(file);
    built ||= fixed;
    add(
      built
        ? { status: fixed ? 'fixed' : 'ok', name: g.name, detail: `${g.file} built` }
        : {
            status: 'fail',
            name: g.name,
            detail: `${g.file} is missing`,
            fix: `corepack pnpm ${g.build.join(' ')}`,
          },
    );
  }

  const chrome = (CHROME_PATHS[process.platform] ?? []).find((p) => p && existsSync(p));
  add(
    chrome
      ? { status: 'ok', name: 'Google Chrome (Playwright)', detail: 'found' }
      : {
          status: 'fail',
          name: 'Google Chrome (Playwright)',
          detail: 'not installed system-wide',
          fix: 'Install Google Chrome: the e2e tests use channel "chrome" and never download a browser',
        },
  );
  const pwsh =
    attempt(() => {
      sh('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
      return true;
    }) === true;
  add(
    pwsh
      ? { status: 'ok', name: 'PowerShell 7 (optional)', detail: 'found' }
      : {
          status: 'warn',
          name: 'PowerShell 7 (optional)',
          detail: 'not found',
          fix: 'Only for runner work (Exchange, Teams, SharePoint) and its tests',
        },
  );

  add(checkClaudeSettings(io));
  // The after-edit hook loads and answers: a file outside the repository is "nothing to report" (exit 0).
  const hook = spawnSync(process.execPath, [path.join(REPO_ROOT, '.claude/hooks/after-edit.mjs')], {
    input: JSON.stringify({ tool_input: { file_path: path.join(os.tmpdir(), 'onboard-check.md') } }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  add(
    hook.status === 0
      ? {
          status: 'ok',
          name: 'Claude Code after-edit hook',
          detail: 'runs (checks every file Claude writes)',
        }
      : {
          status: 'fail',
          name: 'Claude Code after-edit hook',
          detail: 'did not run cleanly',
          fix: 'node .claude/hooks/after-edit.mjs < payload — see .claude/hooks/README.md',
        },
  );
  for (const r of checkSkillsAndAgents(io)) add(r);
  add(
    existsSync(path.join(REPO_ROOT, 'CLAUDE.md'))
      ? { status: 'ok', name: 'CLAUDE.md', detail: 'the rules Claude Code loads in this repository' }
      : { status: 'fail', name: 'CLAUDE.md', detail: 'missing' },
  );
  add(checkEnvFile(io));

  if (!quick && !results.some((r) => r.status === 'fail')) {
    const ok = step('pnpm guard (the guard tests the pre-commit hook runs)', ['guard']);
    add(
      ok
        ? { status: 'ok', name: 'Guard tests' }
        : { status: 'fail', name: 'Guard tests', detail: 'failed (see above)' },
    );
  }
  return finish(results);
}

function finish(results) {
  const failed = results.filter((r) => r.status === 'fail');
  console.log(
    failed.length
      ? `\n${failed.length} to fix before you start — each says how. Then run this again.`
      : '\nReady. Next: docs/onboarding/README.md (the reading order), then mock mode:\n  ADMINFORGE_ENV_FILE=/dev/null PUBLIC_BASE_URL=http://localhost:5173 AUTH_MODE=mock DATA_MODE=fixtures pnpm dev',
  );
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
