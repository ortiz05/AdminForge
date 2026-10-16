import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkEnv, formatEnvReport } from '@adminforge/cli/src/env-check';
import { repoRoot } from '../../lib/repo';

// IAM-04: without WRITE_AUTH_CONTEXT, arming proves a fresh sign-in but not MFA. `adminforge env check` says so as a
// warning (key names only); it doesn't block readiness, so installations without Entra ID P1 keep working.
const EXAMPLE = readFileSync(path.join(repoRoot, 'config', 'example.env'), 'utf8');

describe('env check: write step-up warning', () => {
  it('warns when WRITE_AUTH_CONTEXT is missing in entra mode, without failing readiness', () => {
    const report = checkEnv(EXAMPLE, { AUTH_MODE: 'entra' });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(
      /^WRITE_AUTH_CONTEXT is not set: arming write access proves a fresh sign-in, not MFA\./,
    );
    const { lines } = formatEnvReport(report, '/home/x/.config/adminforge/dev.env', []);
    const text = lines.join('\n');
    expect(text).toContain('Warnings:');
    expect(text).toContain('  ! WRITE_AUTH_CONTEXT is not set');
  });

  it('no warning when it is set (and the value is never printed)', () => {
    const report = checkEnv(EXAMPLE, { AUTH_MODE: 'entra', WRITE_AUTH_CONTEXT: 'c7-secret-looking' });
    expect(report.warnings).toEqual([]);
    const text = formatEnvReport(report, 'dev.env', ['portal']).lines.join('\n');
    expect(text).not.toContain('Warnings:');
    expect(text).not.toContain('c7-secret-looking');
  });

  it('no warning in mock mode', () => {
    expect(checkEnv(EXAMPLE, { AUTH_MODE: 'mock' }).warnings).toEqual([]);
    expect(checkEnv(EXAMPLE, {}, { AUTH_MODE: 'mock' }).warnings).toEqual([]);
  });
});
