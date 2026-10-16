// Live: run one playbook as the validation user — sign in, arm, preview (retrying through Graph replication lag),
// then run with the preview id. For typed confirms pass --confirm-from <stepId>.<field>.
// Usage: pnpm exec tsx tests/live/scripts/run-playbook.ts identity.enable-user '{"userId":"@user:AF-Test-User-02","reason":"…"}'
// Placeholders (`@user:`, `@group:`, `@mailbox:`, `@dl:`, `@team:`, `@site:` … `[#field]`): tests/live/lib/placeholders.ts.
// Output: statuses and error codes; any message text is masked (ids → <id>, addresses → <address>).
import { mask } from '../lib/mask';
import { resolvePlaceholders } from '../lib/placeholders';
import { armWriteAccess, openPortalSession } from '../lib/portal-session';

const [playbook, inputsJson, ...rest] = process.argv.slice(2);
const confirmFrom = rest[rest.indexOf('--confirm-from') + 1];
if (!playbook || !inputsJson)
  throw new Error('usage: run-playbook.ts <playbook> <inputs-json> [--confirm-from step.field]');
const s = await openPortalSession({ forwardToApi: false });

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

type RunError = { code?: string; message?: string };
type Run = {
  run: { status: string; error?: RunError };
  steps: Array<{ stepId: string; status: string; output?: Record<string, unknown>; error?: RunError }>;
};
/** ` — <code>: <masked message>` for a failed run (or step), or nothing. */
const why = (e: RunError | undefined) =>
  e?.code || e?.message
    ? ` — ${e.code ?? 'error'}${e.message ? `: ${mask(e.message).slice(0, 300)}` : ''}`
    : '';
const wait = async (id: string) => {
  for (let i = 0; i < 90; i++) {
    const r = await s.api<Run>('GET', `/api/runs/${id}`);
    if (!['queued', 'running'].includes(r.json.run.status)) return r.json;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('run did not finish');
};
try {
  await armWriteAccess(s, 15, `AdminForge live script: ${playbook}`);
  let preview: Run | undefined;
  let previewId = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const p = await s.api<{ runId: string }>('POST', '/api/runs', { playbook, inputs, dryRun: true });
    previewId = p.json.runId;
    preview = await wait(previewId);
    if (preview.run.status === 'succeeded') break;
    console.log(
      `preview attempt ${attempt}: ${preview.run.status}${why(preview.run.error)} (retrying in 10 s)`,
    );
    await new Promise((res) => setTimeout(res, 10_000));
  }
  if (preview?.run.status !== 'succeeded') throw new Error('preview never succeeded');
  let confirmation: string | undefined;
  if (confirmFrom) {
    const [stepId, field] = confirmFrom.split('.');
    confirmation = String(
      preview.steps.filter((x) => x.stepId === stepId && x.status === 'succeeded').at(-1)?.output?.[field!] ??
        '',
    );
  }
  const created = await s.api<{ runId: string; error?: { code: string; message: string } }>(
    'POST',
    '/api/runs',
    { playbook, inputs, dryRun: false, previewRunId: previewId, ...(confirmation ? { confirmation } : {}) },
  );
  if (!created.json.runId) throw new Error(`run not created: ${created.status}${why(created.json.error)}`);
  const done = await wait(created.json.runId);
  console.log(`${playbook}: ${done.run.status}${why(done.run.error)}`);
  for (const step of done.steps)
    if (step.status === 'failed') console.log(`  step ${step.stepId}: failed${why(step.error)}`);
  await s.api('POST', '/auth/disarm');
} finally {
  await s.close();
}
