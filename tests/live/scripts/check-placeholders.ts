// Live: resolves playbook-input placeholders as the validation user and prints, per placeholder, whether it resolved
// (and to which field) — never the value. Use it before run-playbook.ts to check the AF-Test-* objects are findable.
// Usage: pnpm exec tsx tests/live/scripts/check-placeholders.ts @mailbox:AF-Test-Shared-01 @dl:AF-Test-DL-01 @team:AF-Test-Team-01 @site:AF-Test-Team-01#webUrl
import { parsePlaceholder, resolvePlaceholders } from '../lib/placeholders';
import { openPortalSession } from '../lib/portal-session';

const wanted = process.argv.slice(2);
const bad = wanted.filter((w) => !parsePlaceholder(w));
if (!wanted.length || bad.length)
  throw new Error(
    `usage: check-placeholders.ts @<kind>:<name>[#field]…${bad.length ? ` (not a placeholder: ${bad.join(', ')})` : ''}`,
  );
const s = await openPortalSession({ forwardToApi: false });
let failed = 0;
try {
  for (const w of wanted) {
    try {
      await resolvePlaceholders(s, [w]);
      console.log(`${w}: ok (${parsePlaceholder(w)!.field})`);
    } catch (err) {
      failed++;
      console.log(`${(err as Error).message}`);
    }
  }
} finally {
  await s.close();
}
process.exitCode = failed ? 1 : 0;
