import { Playbook, validateReferences, type Definition } from '@adminforge/schemas';

// A child playbook's confirmation is never asked when a parent starts it, so a parent that starts a child needing
// one must itself be previewed and confirmed (L6).
const pb = (id: string, extra: Record<string, unknown>) =>
  Playbook.parse({
    kind: 'playbook',
    id,
    version: '1.0.0',
    title: id,
    owner: 'tests',
    mode: 'write',
    steps: [
      {
        id: 'w',
        type: 'graph',
        mode: 'write',
        describe: 'Write',
        request: { method: 'PATCH', path: '/users/x', body: { a: 1 } },
      },
    ],
    ...extra,
  }) as Definition;

const parent = (extra: Record<string, unknown>) =>
  pb('test.parent', {
    ...extra,
    // A step that starts a child which writes says mode: write (child-write-mode.test.ts).
    steps: [{ id: 'child', type: 'playbook', ref: 'test.child', mode: 'write', describe: 'Run the child' }],
  });

const check = (...defs: Definition[]) =>
  validateReferences(defs.map((def) => ({ file: `${def.id}.yaml`, def }))).map(
    (e) => `${e.file} ${e.path}: ${e.message}`,
  );

describe('child playbooks that ask for a confirmation', () => {
  const highChild = pb('test.child', { risk: 'high', confirm: { type: 'typed', value: '${ inputs.x }' } });

  it('a parent without a confirm block may not start them', () => {
    expect(check(parent({ risk: 'low' }), highChild)).toEqual([
      'test.parent.yaml confirm: Child playbook "test.child" (risk: high) asks for a confirmation; a playbook that starts it needs a confirm block too (click or typed), so the change is previewed and confirmed first.',
    ]);
    const clickChild = pb('test.child', { risk: 'low', confirm: { type: 'click' } });
    expect(check(parent({ risk: 'medium', confirm: { type: 'none' } }), clickChild)).toHaveLength(1);
  });

  it('a parent that is previewed and confirmed may (its preview includes the child’s plan)', () => {
    expect(check(parent({ risk: 'medium', confirm: { type: 'click' } }), highChild)).toEqual([]);
    expect(check(parent({ risk: 'high', confirm: { type: 'click' } }), highChild)).toEqual([]);
  });

  it('children without a confirmation need nothing from the parent', () => {
    expect(check(parent({ risk: 'low' }), pb('test.child', { risk: 'low' }))).toEqual([]);
  });

  it('compensations that start a playbook follow the same rule', () => {
    const withComp = pb('test.parent', {
      risk: 'low',
      steps: [
        {
          id: 'w',
          type: 'graph',
          mode: 'write',
          describe: 'Write',
          request: { method: 'PATCH', path: '/users/x', body: { a: 1 } },
          compensate: { type: 'playbook', ref: 'test.child' },
        },
      ],
    });
    expect(check(withComp, highChild)).toEqual([expect.stringContaining('asks for a confirmation')]);
  });
});
