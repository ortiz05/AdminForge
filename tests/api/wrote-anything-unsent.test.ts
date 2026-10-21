import { randomUUID } from 'node:crypto';
import type { StepRecord } from '@adminforge/engine';
import { MemoryRunRepository, type NewRun } from '@adminforge/api/src/runs';
import { wroteAnything } from '@adminforge/api/src/runs/run-worker';

// A parked run that has changed nothing yet continues only on the current published version (IAM-02); one that may
// have changed something finishes on its own. A write that failed before it went out (its `when`, building its
// request, access) has no request on its record: it changed nothing — the same rule as the engine's resume re-check.
const run = (): NewRun => ({
  id: randomUUID(),
  kind: 'playbook',
  definitionKey: 'test.unsent',
  definitionVersion: '1.0.0',
  definitionSha256: 'a'.repeat(64),
  dryRun: false,
  trigger: 'interactive',
  identity: 'delegated',
  identityName: null,
  initiatorOid: '00000000-0000-4000-8000-0000000000a1',
  initiatorUpn: 'avery@example.com',
  sessionHash: null,
  scheduleId: null,
  parentRunId: null,
  inputs: {},
  correlationId: randomUUID(),
});
const step = (r: Partial<StepRecord>): StepRecord => ({
  seq: 1,
  stepId: 'w',
  path: 'w',
  type: 'graph',
  attempt: 1,
  status: 'failed',
  actorOid: null,
  mode: 'write',
  request: null,
  plan: null,
  output: null,
  error: { code: 'invalid_request', message: 'The request could not be built.' },
  msRequestId: null,
  startedAt: new Date(),
  endedAt: new Date(),
  ...r,
});

describe('wroteAnything', () => {
  it('a write that failed before it went out is not a write; one that failed at Microsoft is', async () => {
    const repo = new MemoryRunRepository();
    const row = await repo.insertRun(run());
    await repo.saveStep(row.id, step({}));
    expect(await wroteAnything(repo, [row])).toBe(false);
    await repo.saveStep(
      row.id,
      step({ seq: 2, path: 'x', stepId: 'x', request: { method: 'PATCH', path: '/users/x' } }),
    );
    expect(await wroteAnything(repo, [row])).toBe(true);
  });
});
