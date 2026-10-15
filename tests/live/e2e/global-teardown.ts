import { execFileSync } from 'node:child_process';
import { repoRoot } from '@adminforge/config';

/**
 * Disables the validation user again and revokes its sessions (`adminforge provision test-identities --disable`),
 * whatever the outcome of the run. AF_LIVE_KEEP_TESTER=1 leaves the account as it is.
 */
export default function globalTeardown() {
  if (process.env.AF_LIVE_KEEP_TESTER === '1') return;
  execFileSync('pnpm', ['-s', 'adminforge', 'provision', 'test-identities', '--disable'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
