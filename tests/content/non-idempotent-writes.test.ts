import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// After a restart, a run resumes and retries the step that was in flight (D-01), after reading and checking again what
// it read and checked before it (engine.ts › recheck) — but whether the first send took effect is unknown. A write
// whose second send would hurt is `idempotent: false`: it ends `needs_review` ("check whether it took effect") instead
// of being sent again.
//
// - A write that acts on what the person saw (`assert` against `inputs.expected…`, e.g. AVD session numbers, which a
//   host reuses): a sign-out or message that went out may be followed by someone else taking the session number.
// - A device restart sent twice could reboot the device again after the person is back at work; a wipe sent twice
//   could reset a device that kept its enrolment again once it is set up.
// Writes that are safe to send twice (PATCH/PUT to a state, a `$ref` add Graph refuses the second time, set-style
// runner scripts) keep the default; docs/backlog.md lists the ones reviewed.

type Step = {
  id: string;
  type?: string;
  mode?: string;
  that?: unknown;
  idempotent?: boolean;
  steps?: Step[];
};
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const playbooks = loaded.definitions
  .map((d) => d.def as { id: string; kind: string; status?: string; steps?: Step[] })
  .filter((d) => d.kind === 'playbook' && d.status !== 'retired' && d.status !== 'draft');

/** Steps in run order, forEach bodies included. */
const flat = (steps: Step[] = []): Step[] => steps.flatMap((s) => [s, ...flat(s.steps)]);

const NOT_RETRIED: Array<[string, string]> = [
  ['avd.log-off-user-session', 'logOff'],
  ['avd.send-user-message', 'send'],
  ['endpoint.restart-device', 'restart'],
  ['endpoint.wipe-device', 'wipe'],
];

describe('writes whose second send would hurt are not retried after a restart', () => {
  it.each(NOT_RETRIED)('%s › %s is idempotent: false', (id, stepId) => {
    const step = flat(playbooks.find((p) => p.id === id)?.steps).find((s) => s.id === stepId);
    expect(step?.mode).toBe('write');
    expect(step?.idempotent).toBe(false);
  });

  it('every write after a check against what the person saw (inputs.expected…) is idempotent: false', () => {
    const checked = playbooks.filter((p) =>
      flat(p.steps).some(
        (s) => s.type === 'assert' && /\binputs\.expected/.test(JSON.stringify(s.that ?? '')),
      ),
    );
    expect(checked.map((p) => p.id)).toEqual(
      expect.arrayContaining(['avd.log-off-user-session', 'avd.send-user-message']),
    );
    const retried = checked.flatMap((p) => {
      const steps = flat(p.steps);
      const first = steps.findIndex(
        (s) => s.type === 'assert' && /\binputs\.expected/.test(JSON.stringify(s.that ?? '')),
      );
      return steps
        .slice(first + 1)
        .filter((s) => s.mode === 'write' && s.idempotent !== false)
        .map((s) => `${p.id} › ${s.id}`);
    });
    expect(retried).toEqual([]);
  });
});
