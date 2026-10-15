import { execFileSync } from 'node:child_process';
import { repoRoot } from '@adminforge/config';

/**
 * The validation user holds standing directory roles (User Administrator, Global Reader), so it stays disabled except
 * while the live suite runs. This enables it (`adminforge provision test-identities --enable`, provisioner credential
 * from <env>.admin.env, no identifiers printed); global-teardown.ts disables it again. AF_LIVE_KEEP_TESTER=1 leaves
 * the account as it is (e.g. while another live run is in progress).
 */
export default async function globalSetup() {
  if (process.env.AF_LIVE_KEEP_TESTER === '1') return;
  const out = execFileSync('pnpm', ['-s', 'adminforge', 'provision', 'test-identities', '--enable'], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(out);
  // A just-enabled account can be refused for a short while (directory replication).
  if (!/already enabled/.test(out)) await new Promise((r) => setTimeout(r, 30_000));
}
