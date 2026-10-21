import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkContent, unreachableCompensations } from '@adminforge/cli/src/content/check';
import { repoRoot } from '../../lib/repo';

// The engine undoes completed steps only when a step with `onError: compensate` fails (engine.ts › policy,
// finishCompensation). A `compensate` on a playbook's only or last write therefore never runs, yet reads like an undo
// (content review N5): `validate` warns about every `compensate` no such failure can reach. A warning, not an error —
// 35 published playbooks carry one (docs/backlog.md).

const write = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'graph',
  mode: 'write',
  describe: `Write ${id}`,
  request: { method: 'PATCH', path: '/x' },
  compensate: { type: 'graph', request: { method: 'PATCH', path: '/x' } },
  ...extra,
});
const read = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'graph',
  mode: 'read',
  request: { method: 'GET', path: '/x' },
  ...extra,
});
const paths = (def: Record<string, unknown>) => unreachableCompensations(def).map((u) => u.path);

describe('unreachableCompensations', () => {
  it('a compensate on the last (or only) write never runs', () => {
    expect(paths({ steps: [read('lookup'), write('change')] })).toEqual(['steps.change.compensate']);
  });

  it('runs when a later step fails with onError: compensate', () => {
    expect(paths({ steps: [write('first'), write('second', { onError: 'compensate' })] })).toEqual([
      'steps.second.compensate',
    ]);
    expect(paths({ steps: [write('first'), read('check', { onError: 'compensate' })] })).toEqual([]);
  });

  it("a step's own onError: compensate doesn't undo itself (it never completed)", () => {
    expect(paths({ steps: [write('only', { onError: 'compensate' })] })).toEqual(['steps.only.compensate']);
  });

  it('inside a forEach: another item failing into compensation undoes the items that completed', () => {
    const loop = (inner: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      id: 'each',
      type: 'forEach',
      items: '${ inputs.ids }',
      steps: [inner],
      ...extra,
    });
    expect(paths({ steps: [loop(write('item', { onError: 'compensate' }))] })).toEqual([]);
    expect(paths({ steps: [loop(write('item'), { onError: 'compensate' })] })).toEqual([]);
    expect(paths({ steps: [loop(write('item', { onError: 'continue' }))] })).toEqual([
      'steps.each.item.compensate',
    ]);
  });

  it('inside a branch: a later step, or the branch itself, can fail into compensation', () => {
    const branch = (then: unknown[], extra: Record<string, unknown> = {}) => ({
      id: 'maybe',
      type: 'branch',
      if: '${ inputs.x }',
      then,
      ...extra,
    });
    expect(paths({ steps: [branch([write('inner')])] })).toEqual(['steps.maybe.inner.compensate']);
    expect(paths({ steps: [branch([write('inner')]), read('after', { onError: 'compensate' })] })).toEqual(
      [],
    );
    expect(paths({ steps: [branch([write('inner'), read('check')], { onError: 'compensate' })] })).toEqual(
      [],
    );
  });

  it("a runbook's sections run in order", () => {
    const sections = [
      { id: 'a', title: 'A', steps: [write('contain')] },
      { id: 'b', title: 'B', steps: [read('verify', { onError: 'compensate' })] },
    ];
    expect(paths({ sections })).toEqual([]);
    expect(paths({ sections: sections.slice(0, 1) })).toEqual(['sections.a.contain.compensate']);
  });

  it('points at the compensate block', () => {
    expect(unreachableCompensations({ steps: [read('lookup'), write('change')] })[0]!.segments).toEqual([
      'steps',
      1,
      'compensate',
    ]);
  });
});

describe('adminforge validate warns (and only warns) about it', () => {
  it('names the file, the line and what to do', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'af-comp-'));
    try {
      const contentDir = path.join(root, 'content');
      mkdirSync(path.join(contentDir, 'playbooks/identity'), { recursive: true });
      writeFileSync(
        path.join(contentDir, 'playbooks/identity/undo.playbook.yaml'),
        `kind: playbook
id: identity.undo
version: 1.0.0
title: Undo
summary: Changes one thing.
owner: t
risk: low
mode: write
requires: { portalRoles: [Portal.Operator] }
inputs:
  userId: { type: string, format: guid, label: User }
steps:
  - id: change
    type: graph
    mode: write
    describe: Change it
    request:
      method: PATCH
      path: /users/\${ $encode($guid(inputs.userId)) }
      body: { department: X }
    compensate:
      type: graph
      request:
        method: PATCH
        path: /users/\${ $encode($guid(inputs.userId)) }
        body: { department: null }
`,
      );
      const report = await checkContent({ contentDir, repoRoot });
      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([
        expect.stringMatching(
          /^playbooks\/identity\/undo\.playbook\.yaml:21 steps\.change\.compensate: never runs — .*onError: compensate/,
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
