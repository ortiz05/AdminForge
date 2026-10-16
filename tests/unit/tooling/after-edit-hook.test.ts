import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checksFor,
  editedFile,
  REPO_ROOT,
  runChecks,
  validateFeedback,
} from '../../../.claude/hooks/after-edit.mjs';

// .claude/hooks/after-edit.mjs, the Claude Code PostToolUse hook: which checks it runs for each kind of file, and what
// it reports. Commands are faked — nothing here runs Prettier or `adminforge validate` on repository files.
const HOOK = fileURLToPath(new URL('../../../.claude/hooks/after-edit.mjs', import.meta.url));

interface Call {
  cmd: string;
  args: string[];
}

function fakeDeps(opts: { text?: string; fail?: Record<string, { stdout?: string; stderr?: string }> } = {}) {
  const calls: Call[] = [];
  const reads: string[] = [];
  return {
    calls,
    reads,
    deps: {
      run: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        const failure = opts.fail?.[args[1] === 'adminforge' ? 'validate' : 'prettier'];
        if (failure) throw Object.assign(new Error('command failed'), failure);
      },
      readFile: (rel: string) => {
        reads.push(rel);
        return Buffer.from(opts.text ?? '');
      },
    },
  };
}

describe('after-edit hook', () => {
  it('finds the edited file in the hook payload, relative to the repository', () => {
    const abs = path.join(REPO_ROOT, 'portal/apps/web/src/main.tsx');
    expect(editedFile({ tool_response: { filePath: abs }, tool_input: { file_path: '/elsewhere' } })).toBe(
      'portal/apps/web/src/main.tsx',
    );
    expect(editedFile({ tool_input: { file_path: abs } })).toBe('portal/apps/web/src/main.tsx');
    expect(editedFile({ tool_input: { file_path: 'docs/api.md' } })).toBe('docs/api.md');
    expect(editedFile({ tool_input: { file_path: '/etc/hosts' } })).toBeNull();
    expect(editedFile({ tool_input: { file_path: path.join(REPO_ROOT, '../outside.ts') } })).toBeNull();
    expect(editedFile({ tool_input: {} })).toBeNull();
    expect(editedFile(null)).toBeNull();
  });

  it.each([
    ['portal/apps/web/src/pages/Home.tsx', { prettier: true, validate: false, designTokens: true }],
    ['portal/packages/ui/src/theme.css', { prettier: true, validate: false, designTokens: true }],
    ['portal/packages/widgets/src/chart.ts', { prettier: true, validate: false, designTokens: true }],
    ['portal/apps/web/vite.config.ts', { prettier: true, validate: false, designTokens: false }],
    ['portal/apps/api/src/server.ts', { prettier: true, validate: false, designTokens: false }],
    ['tooling/ci/check-bundle.mjs', { prettier: true, validate: false, designTokens: false }],
    ['docs/api.md', { prettier: true, validate: false, designTokens: false }],
    ['package.json', { prettier: true, validate: false, designTokens: false }],
    [
      'portal/content/pages/m365/mailboxes.page.yaml',
      { prettier: false, validate: true, designTokens: false },
    ],
    ['portal/content/playbooks/x.playbook.yml', { prettier: false, validate: true, designTokens: false }],
    [
      'portal/content/scripts/exchange/Get-MailboxSummary.ps1',
      { prettier: false, validate: true, designTokens: false },
    ],
    ['portal/content/scripts/README.md', { prettier: false, validate: false, designTokens: false }],
    ['tests/fixtures/graph/users.json', { prettier: false, validate: false, designTokens: false }],
    ['docs/plans/2026-10-16-plan.md', { prettier: false, validate: false, designTokens: false }],
    ['portal/apps/runner/ps/worker.ps1', { prettier: false, validate: false, designTokens: false }],
  ])('%s → %j', (rel, expected) => {
    expect(checksFor(rel)).toEqual(expected);
  });

  it('formats code with Prettier and reports nothing when it is clean', () => {
    const f = fakeDeps({ text: "export const a = 'bg-panel text-fg-2';\n" });
    expect(runChecks('portal/apps/web/src/a.tsx', f.deps)).toEqual([]);
    expect(f.calls).toEqual([
      {
        cmd: 'pnpm',
        args: ['-s', 'exec', 'prettier', '--write', '--log-level', 'warn', 'portal/apps/web/src/a.tsx'],
      },
    ]);
  });

  it('ignores a Prettier failure (CI decides)', () => {
    const f = fakeDeps({ fail: { prettier: { stderr: 'SyntaxError' } } });
    expect(runChecks('portal/apps/api/src/a.ts', f.deps)).toEqual([]);
  });

  it('reports raw colours and arbitrary values in UI code with their line numbers', () => {
    const f = fakeDeps({ text: "const ok = 'bg-panel';\nconst c = '#ff0000';\nconst w = 'w-[13px]';\n" });
    expect(runChecks('portal/packages/ui/src/x.tsx', f.deps)).toEqual([
      'portal/packages/ui/src/x.tsx:2: Raw colour: use a design token (bg-panel, text-fg-2, var(--af-…)).',
      'portal/packages/ui/src/x.tsx:3: Arbitrary Tailwind value: use a token, or add one in portal/packages/design-tokens.',
    ]);
    expect(f.reads).toEqual(['portal/packages/ui/src/x.tsx']);
  });

  it('validates content after a definition or a runner script changes, and stays quiet when validate passes', () => {
    for (const rel of ['portal/content/pages/x.page.yaml', 'portal/content/scripts/exchange/Get-X.ps1']) {
      const f = fakeDeps();
      expect(runChecks(rel, f.deps)).toEqual([]);
      expect(f.calls).toEqual([{ cmd: 'pnpm', args: ['-s', 'adminforge', 'validate'] }]);
      expect(f.reads).toEqual([]);
    }
  });

  it('passes on the stale-pin errors validate reports after a script edit', () => {
    const stale =
      '✗ pages/m365/mailboxes.page.yaml:74 datasources.mailboxes.sha256: pinned sha256 does not match portal/content/scripts/exchange/Get-MailboxSummary.ps1 (its sha256 is ' +
      'a'.repeat(64) +
      ') — update the pin; the runner refuses a script whose sha256 differs.';
    const warnings = Array.from(
      { length: 60 },
      (_, i) => `⚠ reports/r${i}.report.yaml: uses Microsoft Graph beta.`,
    );
    const f = fakeDeps({
      fail: { validate: { stdout: [stale, ...warnings, '✗ 1 problem(s) in portal/content.'].join('\n') } },
    });
    expect(runChecks('portal/content/scripts/exchange/Get-MailboxSummary.ps1', f.deps)).toEqual([
      `adminforge validate failed after editing portal/content/scripts/exchange/Get-MailboxSummary.ps1:\n${stale}\n✗ 1 problem(s) in portal/content.`,
    ]);
  });

  it('shows the end of the output when validate fails without ✗ lines, at most 40 lines', () => {
    const crash = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    expect(validateFeedback(crash).split('\n')).toEqual(
      Array.from({ length: 40 }, (_, i) => `line ${i + 60}`),
    );
    const many = Array.from({ length: 50 }, (_, i) => `✗ e${i}`).join('\n');
    expect(validateFeedback(many).split('\n')).toHaveLength(40);
  });

  it('exits 0 for files it has nothing to check and for payloads it cannot read', () => {
    for (const stdin of [
      JSON.stringify({ tool_input: { file_path: '/etc/hosts' } }),
      JSON.stringify({ tool_input: { file_path: path.join(REPO_ROOT, 'portal/apps/runner/ps/worker.ps1') } }),
      'not json',
      '',
    ]) {
      const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8' });
      expect([r.status, r.stderr]).toEqual([0, '']);
    }
  });
});
