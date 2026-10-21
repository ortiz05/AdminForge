import { Playbook, validateReferences, type Definition } from '@adminforge/schemas';

// M1 (whole-branch security review): the engine finds writes by each step's own `mode` — where the implicit approval
// gate of `approval: { required: true }` goes, whether an approver or the person confirming a manual step must be
// armed. A step that starts a child playbook which writes is a write, so validate refuses it unless it says
// `mode: write`; a compensation always writes, so the step it undoes must say `mode: write` too.

const WRITE = {
  id: 'w',
  type: 'graph',
  mode: 'write',
  describe: 'Write',
  request: { method: 'PATCH', path: '/users/x', body: { a: 1 } },
};
const READ = { id: 'r', type: 'graph', request: { method: 'GET', path: '/users/x' } };

const pb = (id: string, extra: Record<string, unknown> = {}) =>
  Playbook.parse({
    kind: 'playbook',
    id,
    version: '1.0.0',
    title: id,
    owner: 'tests',
    risk: 'low',
    mode: 'write',
    steps: [WRITE],
    ...extra,
  }) as Definition;

const check = (...defs: Definition[]) =>
  validateReferences(defs.map((def) => ({ file: `${def.id}.yaml`, def }))).map(
    (e) => `${e.path}: ${e.message}`,
  );

const writingChild = pb('test.child');
const readingChild = pb('test.child', { mode: 'read', steps: [READ] });

describe('a step that starts a child playbook which writes', () => {
  it('is refused without mode: write — the critical change would otherwise run before its approval', () => {
    const parent = pb('test.parent', {
      risk: 'critical',
      confirm: { type: 'click' },
      approval: { required: true },
      steps: [{ id: 'child', type: 'playbook', ref: 'test.child' }],
    });
    expect(check(parent, writingChild)).toEqual([
      'steps[0].mode: Child playbook "test.child" writes; declare mode: write on this step.',
    ]);
  });

  it('is refused inside a forEach and a branch too', () => {
    const parent = pb('test.parent', {
      steps: [
        {
          id: 'each',
          type: 'forEach',
          items: '${ [1, 2] }',
          steps: [{ id: 'child', type: 'playbook', ref: 'test.child' }],
        },
        {
          id: 'pick',
          type: 'branch',
          if: '${ true }',
          then: [{ id: 'other', type: 'playbook', ref: 'test.child', mode: 'read' }],
        },
      ],
    });
    expect(check(parent, writingChild)).toEqual([
      'steps[0].steps[0].mode: Child playbook "test.child" writes; declare mode: write on this step.',
      'steps[1].then[0].mode: Child playbook "test.child" writes; declare mode: write on this step.',
    ]);
  });

  it('passes with mode: write, and a child that only reads needs nothing', () => {
    const declared = pb('test.parent', {
      steps: [{ id: 'child', type: 'playbook', ref: 'test.child', mode: 'write', describe: 'Run the child' }],
    });
    expect(check(declared, writingChild)).toEqual([]);
    const reads = pb('test.parent', { steps: [{ id: 'child', type: 'playbook', ref: 'test.child' }] });
    expect(check(reads, readingChild)).toEqual([]);
  });

  it('in a read-only parent says both what the step and the playbook must declare', () => {
    const parent = pb('test.parent', {
      mode: 'read',
      steps: [{ id: 'child', type: 'playbook', ref: 'test.child' }],
    });
    expect(check(parent, writingChild)).toEqual([
      'steps[0].ref: Child playbook "test.child" writes; set the top-level mode: write.',
      'steps[0].mode: Child playbook "test.child" writes; declare mode: write on this step.',
    ]);
  });
});

describe('compensations', () => {
  it('a step whose compensation starts a writing child must say mode: write', () => {
    const parent = pb('test.parent', {
      steps: [
        { ...READ, compensate: { type: 'playbook', ref: 'test.child' } },
        { ...WRITE, onError: 'compensate' },
      ],
    });
    expect(check(parent, writingChild)).toEqual([
      'steps[0].mode: A compensation undoes this step’s change, and compensations always write: declare mode: write on this step.',
    ]);
  });

  it('so does a step with any compensation (it runs as a write when a later step fails)', () => {
    const parent = pb('test.parent', {
      steps: [
        {
          ...READ,
          compensate: { type: 'graph', request: { method: 'DELETE', path: '/users/x/memberOf/y/$ref' } },
        },
        { ...WRITE, onError: 'compensate' },
      ],
    });
    expect(check(parent)).toEqual([
      'steps[0].mode: A compensation undoes this step’s change, and compensations always write: declare mode: write on this step.',
    ]);
  });

  it('on a write step is fine', () => {
    const parent = pb('test.parent', {
      steps: [{ ...WRITE, compensate: { type: 'playbook', ref: 'test.child' } }],
    });
    expect(check(parent, writingChild)).toEqual([]);
  });
});
