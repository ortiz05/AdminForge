import path from 'node:path';
import { flattenSteps, loadContentDir, walkSteps, type Step } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// M1 (whole-branch security review): where the engine puts the implicit approval gate, and whether whoever decides a
// gate or confirms a manual step must be armed, follows each step's own `mode`. Every shipped step that starts a child
// playbook which writes — or carries a compensation, which always writes — says `mode: write` (validate refuses the
// rest; this pins it for the content as shipped).

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
type Automation = Parameters<typeof flattenSteps>[0] & { id: string; kind: string; mode: string };
const defs = loaded.definitions.map((d) => d.def as unknown as Automation);
const byId = new Map(defs.map((d) => [d.id, d]));
const automations = defs.filter((d) => d.kind === 'playbook' || d.kind === 'runbook');

const stepsOf = (def: Automation) => {
  const out: Step[] = [];
  walkSteps(flattenSteps(def), (s) => out.push(s));
  return out;
};

describe('steps that start a writing child playbook or carry a compensation say mode: write', () => {
  it('finds the child playbook steps and compensations it checks', () => {
    const children = automations.flatMap(stepsOf).filter((s) => s.type === 'playbook');
    expect(children.length).toBeGreaterThan(15);
    expect(automations.flatMap(stepsOf).filter((s) => s.compensate).length).toBeGreaterThan(20);
  });

  it('every child playbook step whose child writes', () => {
    const missing = automations.flatMap((def) =>
      stepsOf(def)
        .filter((s) => s.type === 'playbook' && byId.get(s.ref)?.mode === 'write' && s.mode !== 'write')
        .map((s) => `${def.id} › ${s.id}`),
    );
    expect(missing).toEqual([]);
  });

  it('every step with a compensation', () => {
    const missing = automations.flatMap((def) =>
      stepsOf(def)
        .filter((s) => s.compensate && s.mode !== 'write')
        .map((s) => `${def.id} › ${s.id}`),
    );
    expect(missing).toEqual([]);
  });

  it('validate reports none of them', () => {
    expect(
      loaded.errors.filter((e) => /declare mode: write on this step/.test(e.message)).map((e) => e.file),
    ).toEqual([]);
  });
});
