// Live: run one playbook as the validation user — sign in, arm, preview (retrying through Graph replication lag),
// then run with the preview id. For typed confirms pass --confirm-from <stepId>.<field>.
// Usage: pnpm exec tsx tests/live/scripts/run-playbook.ts identity.enable-user '{"userId":"…","reason":"…"}'
import { armWriteAccess, openPortalSession } from '../lib/portal-session';

const [playbook, inputsJson, ...rest] = process.argv.slice(2);
const confirmFrom = rest[rest.indexOf('--confirm-from') + 1];
if (!playbook || !inputsJson)
  throw new Error('usage: run-playbook.ts <playbook> <inputs-json> [--confirm-from step.field]');
const inputs = JSON.parse(inputsJson) as Record<string, unknown>;
const s = await openPortalSession({ forwardToApi: false });

// "@user:AF-Test-User-02" / "@group:AF-Test-Group-01" placeholders resolve through the portal's search (no ids on the command line).
for (const [k, v] of Object.entries(inputs)) {
  const m = typeof v === 'string' ? /^@(user|group|device|app):(.+)$/.exec(v) : null;
  if (!m) continue;
  const r = await s.api<{ results: Array<{ id?: string; title: string }> }>(
    'GET',
    `/api/search?q=${encodeURIComponent(m[2]!)}&type=${m[1]}`,
  );
  const hit = r.json.results.find((x) => x.title === m[2]);
  if (!hit?.id) throw new Error(`could not resolve ${v}`);
  inputs[k] = hit.id;
}

type Run = {
  run: { status: string; error?: { message?: string } };
  steps: Array<{ stepId: string; status: string; output?: Record<string, unknown> }>;
};
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
      `preview attempt ${attempt}: ${preview.run.status} — ${preview.run.error?.message ?? ''} (retrying in 10 s)`,
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
  if (!created.json.runId) throw new Error(`run not created: ${created.status} ${created.json.error?.code}`);
  const done = await wait(created.json.runId);
  console.log(
    `${playbook}: ${done.run.status}${done.run.error?.message ? ` — ${done.run.error.message}` : ''}`,
  );
  await s.api('POST', '/auth/disarm');
} finally {
  await s.close();
}
