import {
  hasWriteSteps,
  IMPLICIT_APPROVAL,
  implicitApprovalIndex,
  writesAfter,
  type ChildRunner,
} from '@adminforge/engine';
import { harness, playbook, read, write } from './helpers';

// M1 (whole-branch security review), defence in depth: validate refuses a step that starts a writing child playbook
// without `mode: write`, but the engine doesn't rely on it. In a write playbook a step that starts a child playbook,
// or carries a compensation (which always writes), counts as a write wherever the engine places the implicit approval
// gate or decides whether the person deciding a gate must be armed.

const child = (id = 'child') => ({ id, type: 'playbook', ref: 'test.child' });
const critical = { risk: 'critical', confirm: { type: 'click' }, approval: { required: true } };

describe('engine: child playbook steps count as writes in a write playbook', () => {
  it('the implicit approval gate goes before a child step that does not say mode: write', () => {
    const def = playbook([read('lookup'), child()], critical);
    expect(implicitApprovalIndex(def)).toBe(1);
    expect(hasWriteSteps(def)).toBe(true);
  });

  it('and before a read step with a compensation', () => {
    const undo = { type: 'graph', request: { method: 'DELETE', path: '/groups/g/members/u/$ref' } };
    const def = playbook([read('lookup', '/users/u', { compensate: undo }), write('add')], critical);
    expect(implicitApprovalIndex(def)).toBe(0);
  });

  it('an approval followed only by a child step still needs an armed approver', () => {
    const def = playbook([{ id: 'approve', type: 'approval' }, child()]);
    expect(writesAfter(def, 'approve')).toBe(true);
    expect(writesAfter(playbook([child(), { id: 'approve', type: 'approval' }]), 'approve')).toBe(false);
    const looped = playbook([
      {
        id: 'each',
        type: 'forEach',
        items: '${ [1, 2] }',
        steps: [{ id: 'approve', type: 'approval' }, child()],
      },
    ]);
    expect(writesAfter(looped, 'approve')).toBe(true);
    expect(writesAfter(playbook([child()], critical), IMPLICIT_APPROVAL)).toBe(true);
  });

  it('in a read-only playbook a child step stays a read (its children can only read)', () => {
    const def = playbook([read('lookup'), child()], { mode: 'read', approval: { required: true } });
    expect(implicitApprovalIndex(def)).toBe(-1);
    expect(hasWriteSteps(def)).toBe(false);
    expect(
      writesAfter(playbook([{ id: 'approve', type: 'approval' }, child()], { mode: 'read' }), 'approve'),
    ).toBe(false);
  });

  it('a run of a critical playbook whose only step starts a child waits for approval before the child starts', async () => {
    const started: string[] = [];
    const children: ChildRunner = {
      run: async (req) => {
        started.push(req.ref);
        return { runId: 'child-1', status: 'succeeded', outputs: {}, error: null, plan: [] };
      },
    };
    const h = harness(playbook([child()], critical), { engine: { children } });
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(started).toEqual([]);
    expect([...h.store.tasks.values()][0]).toMatchObject({ path: IMPLICIT_APPROVAL });
  });
});
