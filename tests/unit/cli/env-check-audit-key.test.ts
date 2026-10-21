import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkEnv, formatEnvReport } from '@adminforge/cli/src/env/env-check';
import { repoRoot } from '../../lib/repo';

// S-10: without AUDIT_CHAIN_KEY the audit log is unkeyed — whoever can write the database volume can rewrite it and
// re-hash it. `adminforge env check` says so as a warning (key names only; the portal keeps working without it), and
// marks a malformed key invalid, as the API refuses it at start.
const EXAMPLE = readFileSync(path.join(repoRoot, 'config', 'example.env'), 'utf8');
const key = () => randomBytes(32).toString('base64');
const entra = { AUTH_MODE: 'entra', WRITE_AUTH_CONTEXT: 'c1' };

describe('env check: audit chain key', () => {
  it('warns when AUDIT_CHAIN_KEY is missing, without failing readiness', () => {
    const report = checkEnv(EXAMPLE, entra);
    expect(report.warnings).toEqual([
      expect.stringMatching(
        /^AUDIT_CHAIN_KEY is not set: the audit log is unkeyed, .*openssl rand -base64 32/,
      ),
    ]);
    expect(report.keys.find((k) => k.key === 'AUDIT_CHAIN_KEY')?.requiredFor).toEqual([]);
    expect(formatEnvReport(report, 'dev.env', []).lines.join('\n')).toContain(
      '  ! AUDIT_CHAIN_KEY is not set',
    );
  });

  it('no warning with a key, and neither value is printed', () => {
    const current = key();
    const previous = `${key()}, ${key()}`;
    const report = checkEnv(EXAMPLE, {
      ...entra,
      AUDIT_CHAIN_KEY: current,
      AUDIT_CHAIN_PREVIOUS_KEYS: previous,
    });
    expect(report.warnings).toEqual([]);
    for (const k of ['AUDIT_CHAIN_KEY', 'AUDIT_CHAIN_PREVIOUS_KEYS'])
      expect(report.keys.find((r) => r.key === k)?.state).toBe('set');
    const text = formatEnvReport(report, 'dev.env', ['portal']).lines.join('\n');
    expect(text).not.toContain(current);
    expect(text).not.toContain(previous.split(',')[0]!);
  });

  it('marks malformed keys invalid as the API refuses them: format, a repeated byte, TOKEN_CACHE_KEY, options alone', () => {
    const token = key();
    const report = checkEnv(EXAMPLE, {
      ...entra,
      TOKEN_CACHE_KEY: token,
      AUDIT_CHAIN_KEY: randomBytes(16).toString('base64'),
      AUDIT_CHAIN_PREVIOUS_KEYS: `${key()},not-a-key`,
      AUDIT_CHAIN_LOST_KEY_IDS: 'not-an-id',
      AUDIT_CHAIN_KEYED_SINCE: '0',
    });
    const problem = (k: string) => report.keys.find((r) => r.key === k);
    expect(problem('AUDIT_CHAIN_KEY')).toMatchObject({
      state: 'invalid',
      problem: expect.stringMatching(/^must be 32 random bytes, base64/),
    });
    expect(problem('AUDIT_CHAIN_PREVIOUS_KEYS')).toMatchObject({
      state: 'invalid',
      problem: expect.stringMatching(/^each entry must be 32 random bytes/),
    });
    expect(problem('AUDIT_CHAIN_LOST_KEY_IDS')).toMatchObject({ state: 'invalid' });
    expect(problem('AUDIT_CHAIN_KEYED_SINCE')).toMatchObject({ state: 'invalid' });
    for (const bad of [Buffer.alloc(32, 9).toString('base64'), token])
      expect(
        checkEnv(EXAMPLE, { ...entra, TOKEN_CACHE_KEY: token, AUDIT_CHAIN_KEY: bad }).keys.find(
          (r) => r.key === 'AUDIT_CHAIN_KEY',
        )?.state,
      ).toBe('invalid');
    expect(
      checkEnv(EXAMPLE, { ...entra, AUDIT_CHAIN_KEYED_SINCE: '120' }).keys.find(
        (r) => r.key === 'AUDIT_CHAIN_KEYED_SINCE',
      ),
    ).toMatchObject({ state: 'invalid', problem: expect.stringMatching(/needs AUDIT_CHAIN_KEY/) });
  });

  it('no warning in mock mode', () => {
    expect(checkEnv(EXAMPLE, { AUTH_MODE: 'mock' }).warnings).toEqual([]);
  });
});
