/**
 * `adminforge test [pattern]` — runs every playbook and runbook `tests:` block (content/playbook-tests.ts): dry runs
 * with mocked step outputs, so nothing reaches Microsoft or the database. `pattern` keeps the definitions whose id
 * or file contains it.
 *
 * Prints one ✓/✗ line per test and a summary; parse problems of other files are shown as warnings (`adminforge
 * validate` reports them). Exit code 1 when a test fails; when the engine can't be loaded it warns and exits 0.
 */
import type { ContentCliContext } from '../content/context';
import { runPlaybookTests } from '../content/playbook-tests';

/** `adminforge test [pattern]` — true when every test passed (or none could run). */
export async function testContent(ctx: ContentCliContext, opts: { pattern?: string } = {}): Promise<boolean> {
  const run = await runPlaybookTests(ctx, opts);
  if (!run.ran) {
    ctx.out('⚠ The playbook engine (runPlaybookTests) is not available; no tests were run.');
    return true;
  }
  for (const p of run.problems) ctx.out(`⚠ ${p}`);
  for (const l of run.lines) ctx.out(l);
  ctx.out(
    `${run.failed ? '✗' : '✓'} ${run.passed} passed, ${run.failed} failed (${run.targets} definitions with tests${opts.pattern ? ` matching "${opts.pattern}"` : ''}).`,
  );
  return run.failed === 0;
}
