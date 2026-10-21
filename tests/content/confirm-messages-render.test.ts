import path from 'node:path';
import { renderConfirm } from '@adminforge/api/src/runs/confirm';
import { MemoryRunStore, runPlaybookTest, type AutomationDefinition } from '@adminforge/engine';
import { loadContentDir, unusualCharacters } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The confirm dialog shows `confirm.message` and the text to type as the API renders them from the preview's step
// outputs (it printed raw `${ … }` before). Every active playbook and runbook with a confirmation is rendered here the
// API's way from each of its own succeeded dry-run tests (the mocked step outputs a preview would store): the message
// and the value must come out as text a person can read — no template left, nothing undefined, no JSON.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const byId = new Map(loaded.definitions.map((d) => [d.def.id, d.def as AutomationDefinition]));
const confirming = [...byId.values()].filter(
  (d) =>
    (d.kind === 'playbook' || d.kind === 'runbook') &&
    d.status !== 'retired' &&
    d.confirm &&
    d.confirm.type !== 'none',
);

/** What reads wrong in a rendered confirmation. */
function problems(text: string): string[] {
  const out: string[] = [];
  if (text.includes('${')) out.push('a template is left');
  if (/\bundefined\b|\bNaN\b|\[object Object\]|\[redacted\]/.test(text)) out.push('a value is missing');
  if (/[{[]\s*"/.test(text)) out.push('JSON in the text');
  if (/ {2}|\s[,.?]/.test(text)) out.push('a gap where a value should be');
  if (unusualCharacters(text).some((c) => c.invisible)) out.push('an invisible character');
  return out;
}

interface Rendered {
  id: string;
  test: string;
  type: string;
  value: string | null;
  message: string | null;
}

/** Each succeeded dry-run test of `def`, rendered as the API renders the confirmation of a preview. */
async function renderAll(def: AutomationDefinition): Promise<Rendered[]> {
  const out: Rendered[] = [];
  const create = vi.spyOn(MemoryRunStore.prototype, 'create');
  try {
    for (const [i, t] of (def.tests ?? []).entries()) {
      if (t.dryRun === false || t.expect.status !== 'succeeded') continue;
      create.mockClear();
      const res = await runPlaybookTest(def, t, i, { resolveChild: (ref) => byId.get(ref) ?? null });
      if (res.status !== 'succeeded') continue;
      // The test's own run store: the first run it created (children come later).
      const store = create.mock.contexts[0] as MemoryRunStore;
      const runId = (create.mock.calls[0]![0] as { id: string }).id;
      const run = (await store.getRun(runId))!;
      const steps: Record<string, { output: unknown; status: string; error: unknown }> = {};
      for (const r of await store.listSteps(runId)) {
        if (/[[#>]/.test(r.path)) continue;
        steps[r.stepId] = { output: r.output ?? undefined, status: r.status, error: r.error };
      }
      const scope = {
        inputs: run.inputs,
        steps,
        run: { id: runId, dryRun: true, definition: { key: def.id, version: def.version } },
        user: {
          kind: 'delegated',
          oid: t.user?.oid ?? '00000000-0000-4000-8000-00000000c0de',
          upn: t.user?.upn ?? 'tester@example.com',
          roles: t.user?.roles ?? ['Portal.Reader', 'Portal.Operator'],
        },
        env: t.env ?? {},
        now: '2026-01-15T12:00:00.000Z',
      };
      const c = (await renderConfirm(def.confirm, scope, []))!;
      out.push({ id: def.id, test: t.name, ...c });
    }
  } finally {
    create.mockRestore();
  }
  return out;
}

describe('confirmations render from the preview (every playbook and runbook with one)', () => {
  it('finds the templated ones', () => {
    const templated = confirming.filter(
      (d) => d.confirm!.message?.includes('${') || d.confirm!.value?.includes('${'),
    );
    expect(templated.map((d) => d.id)).toEqual(
      expect.arrayContaining([
        'identity.revoke-consent-grant',
        'avd.log-off-user-session',
        'identity.leaver',
        'endpoint.wipe-device',
      ]),
    );
  });

  it.each(confirming.map((d) => [d.id, d] as const))('%s', async (_id, def) => {
    const rendered = await renderAll(def);
    const templated = def.confirm!.message?.includes('${') || def.confirm!.value?.includes('${');
    // A templated confirmation is only seen through a preview: its tests must include one that succeeds.
    if (templated) expect(rendered.length, 'a succeeded dry-run test to render it from').toBeGreaterThan(0);
    for (const r of rendered) {
      const where = `${r.id} › ${r.test}`;
      if (def.confirm!.type === 'typed') {
        expect(r.value, `${where}: value`).not.toBeNull();
        expect(problems(r.value!), `${where}: value "${r.value}"`).toEqual([]);
      }
      if (def.confirm!.message) {
        expect(r.message, `${where}: message`).not.toBeNull();
        expect(problems(r.message!), `${where}: message "${r.message}"`).toEqual([]);
      }
    }
  });
});
