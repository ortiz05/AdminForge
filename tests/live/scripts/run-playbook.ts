// Live: run one playbook as the validation user — sign in, arm, preview (retrying through Graph replication lag),
// then run with the preview id and wait for the run to settle (lib/runs.ts).
//
// Usage (repository root; the validation user enabled — see tests/live/README.md):
//   pnpm exec tsx tests/live/scripts/run-playbook.ts <playbook> '<inputs JSON>' [--confirm-from <stepId>.<field>]
//   An https PUBLIC_BASE_URL is the deployed portal behind Caddy: the API is called through that same origin
//   (AF_LIVE_INSECURE_TLS=1 for Caddy's local CA); otherwise a dev stack's API on API_PORT.
//   e.g. … identity.enable-user '{"userId":"@user:AF-Test-User-02","reason":"…"}'
// Inputs: placeholders (`@user:`, `@group:`, `@mailbox:`, `@dl:`, `@team:`, `@site:` … `[#field]`) resolve as the
//   validation user (lib/placeholders.ts), so no ids or addresses go on the command line. --confirm-from answers a
//   typed confirm with that step's output in the preview (what the UI would show).
// Output: the run status, the error code of a failed run and of each failed step, messages masked (lib/mask.ts), and
//   for each write runner step its result's flags and counts (booleans, numbers, list lengths — never strings or ids).
//   Exit code 1 unless the run succeeded.
// Safety: writes for real once armed — only on AF-Test-* objects (README "Safety rules"); the server enforces preview,
//   confirm and approval. Disarms afterwards, also when the run or the script fails.
import { loadEnv } from '@adminforge/config';
import { openPublicSession } from '../lib/accuracy-session';
import { why } from '../lib/mask';
import { resolvePlaceholders } from '../lib/placeholders';
import { armWriteAccess, openPortalSession } from '../lib/portal-session';
import { previewThenRun, settle, stepOutput } from '../lib/runs';

const [playbook, inputsJson, ...rest] = process.argv.slice(2);
const confirmFrom = rest.includes('--confirm-from') ? rest[rest.indexOf('--confirm-from') + 1] : undefined;
if (!playbook || !inputsJson || (rest.includes('--confirm-from') && !confirmFrom?.includes('.')))
  throw new Error('usage: run-playbook.ts <playbook> <inputs-json> [--confirm-from step.field]');
const deployed = /^https:/i.test(loadEnv(process.env, { admin: true }).PUBLIC_BASE_URL ?? '');
const s = deployed ? await openPublicSession() : await openPortalSession({ forwardToApi: false });

// Placeholders resolve as the validation user through the portal (search, read-only datasources); nothing is printed.
let inputs: Record<string, unknown>;
try {
  const resolved = await resolvePlaceholders(s, JSON.parse(inputsJson) as Record<string, unknown>);
  inputs = resolved.inputs;
  if (resolved.count) console.log(`resolved ${resolved.count} placeholder(s)`);
} catch (err) {
  await s.close();
  throw err;
}

let armed = false;
try {
  await armWriteAccess(s, 15, `AdminForge live script: ${playbook}`);
  armed = true;
  const [stepId, field] = confirmFrom?.split('.') ?? [];
  const { preview, run } = await previewThenRun(s, playbook, inputs, {
    onRetry: (attempt, p) =>
      console.log(`preview attempt ${attempt}: ${p.run.status}${why(p.run.error)} (retrying in 10 s)`),
    ...(stepId && field
      ? {
          confirm: (p) => {
            const value = stepOutput(p, stepId)?.[field];
            return value === undefined || value === null ? undefined : String(value);
          },
        }
      : {}),
  });
  if (!run) throw new Error(`preview never succeeded: ${preview.run.status}${why(preview.run.error)}`);
  const done = await settle(s, run);
  console.log(`${playbook}: ${done.run.status}${why(done.run.error)}`);
  for (const step of done.steps) {
    if (step.status === 'failed') console.log(`  step ${step.stepId}: failed${why(step.error)}`);
    const facts = step.type === 'runner' && step.mode === 'write' ? factsOf(step.output) : undefined;
    if (facts) console.log(`  step ${step.stepId}: ${step.status} ${facts}`);
  }
  process.exitCode = done.run.status === 'succeeded' ? 0 : 1;
} finally {
  // Disarm whatever happened: write access would otherwise stay on until it expires.
  if (armed) await s.api('POST', '/auth/disarm').catch(() => undefined);
  await s.close();
}

/** A runner step's (first) result as `key=value` for booleans and numbers and `key=<length>` for lists. */
function factsOf(output: unknown): string | undefined {
  const first: unknown = Array.isArray(output) ? output[0] : output;
  if (!first || typeof first !== 'object') return undefined;
  const parts = Object.entries(first as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'boolean' || typeof v === 'number'
      ? [`${k}=${v}`]
      : Array.isArray(v)
        ? [`${k}=${v.length}`]
        : [],
  );
  return parts.length ? parts.join(' ') : undefined;
}
