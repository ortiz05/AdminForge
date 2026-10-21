import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { findPwsh } from '@adminforge/runner/src/config';
import { repoRoot } from '../../lib/repo';

// Runs the PowerShell-side tests (tests/runner/pester) with the pinned Pester version.
const pwsh = findPwsh();
const hasPwsh =
  spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;

describe.skipIf(!hasPwsh)('AdminForge.Runner Pester suite', () => {
  it('passes', () => {
    const run = spawnSync(
      pwsh,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(repoRoot, 'tests/runner/pester/run.ps1'),
        '-Output',
        'Normal',
      ],
      {
        encoding: 'utf8',
        timeout: 280_000,
        env: { ...process.env, NO_COLOR: '1' },
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    const summary = /PESTER total=(\d+) passed=(\d+) failed=(\d+)/.exec(output);
    expect(summary, output.slice(-4000)).not.toBeNull();
    expect(Number(summary![3]), output.slice(-4000)).toBe(0);
    expect(Number(summary![2])).toBeGreaterThan(0);
    expect(run.status, output.slice(-4000)).toBe(0);
  }, 300_000);
});
