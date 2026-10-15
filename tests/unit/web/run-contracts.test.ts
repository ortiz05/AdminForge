import {
  approvalRunDetail,
  bulkDetail,
  failedDetail,
  liveDetail,
  previewDetail,
  runbookRunDetail,
  runsList,
} from '../../e2e/fixtures/automation';
import { readApprovalItem } from '@adminforge/web/src/runs/approvals';
import {
  isParked,
  isTerminal,
  labelOf,
  latestSteps,
  readLog,
  readRunDetail,
  readRunSummary,
  RunListResponse,
  StartRunResponse,
} from '@adminforge/web/src/runs/contracts';
import { applyProgressEvent, applyRunEvent, applyStepEvent, isNested, topLevelKey } from '@adminforge/web/src/runs/useRunLive';
import { buildTimeline, stepIndex } from '@adminforge/web/src/runs/RunTimeline';
import { disableUser } from '../../e2e/fixtures/automation';
import type { Playbook } from '@adminforge/schemas';

describe('run contracts (GET /api/runs, GET /api/runs/:id)', () => {
  it('reads the list and its summaries (definitionKey, initiatorUpn, automation identity)', () => {
    const { items } = RunListResponse.parse(runsList());
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({ key: 'identity.disable-user', title: 'Disable sign-in', status: 'running', initiator: { upn: 'mock.engineer@example.com' } });
    expect(items.find((r) => r.identity === 'automation')?.trigger).toBe('schedule');
    expect(readRunSummary({ runId: 'x', playbook: 'a.b', status: 'weird' })).toMatchObject({ id: 'x', key: 'a.b', status: 'queued' });
  });

  it('reads a dry-run detail: steps, plan, tasks, children', () => {
    const d = readRunDetail(previewDetail());
    expect(d.run).toMatchObject({ dryRun: true, status: 'succeeded', version: '1.0.0', correlationId: expect.any(String) });
    expect(d.plan.map((p) => p.stepId)).toEqual(['disable', 'revoke']);
    expect(d.steps.find((s) => s.stepId === 'disable')).toMatchObject({ mode: 'write', status: 'planned' });
    expect(readRunDetail(bulkDetail()).children).toHaveLength(3);
  });

  it('reads approval and manual tasks, and what a run waits for', () => {
    const a = readRunDetail(approvalRunDetail());
    expect(a.run.waiting).toMatchObject({ kind: 'approval', stepId: '$approval' });
    expect(a.tasks[0]).toMatchObject({ kind: 'approval', stepId: '$approval', writesAfter: true, canDecide: true, approvers: ['Playbook.Approver'] });
    const m = readRunDetail(runbookRunDetail());
    expect(m.tasks[0]).toMatchObject({ kind: 'manual', stepId: 'mailbox', checklist: ['Mailbox converted to shared', 'Manager has Full Access'] });
    expect(readRunDetail(failedDetail()).run.error).toMatchObject({ status: 403, hint: expect.stringContaining('PIM') });
  });

  it('rejects a response without a run', () => {
    expect(() => readRunDetail({ steps: [] })).toThrow();
    expect(StartRunResponse.parse({ runId: 'r1', status: 'queued' })).toEqual({ runId: 'r1' });
    expect(() => StartRunResponse.parse({})).toThrow();
  });

  it('status groups', () => {
    expect(isTerminal('compensated')).toBe(true);
    expect(isTerminal('awaiting_arm')).toBe(false);
    expect(isParked('awaiting_reauth')).toBe(true);
  });

  it('approval inbox items: write gates need arming; the server decides who may decide', () => {
    const item = readApprovalItem(approvalRunDetail().tasks[0])!;
    expect(item).toMatchObject({ subjectType: 'run', stepId: '$approval', requiresArm: true, canDecide: true, ref: 'identity.disable-user' });
    expect(readApprovalItem({ id: 'm', subjectId: 'r', kind: 'manual' })).toBeNull();
  });
});

describe('live updates (SSE envelope {id, type, ts, stepSeq, data})', () => {
  it('step events update the record with the same path or append one', () => {
    const d = readRunDetail(liveDetail('running'));
    const a = applyStepEvent(d, { scope: 'step', path: 'disable', stepId: 'disable', type: 'graph', status: 'succeeded', attempt: 1 }, 3);
    expect(latestSteps(a.steps).find((s) => s.path === 'disable')?.status).toBe('succeeded');
    const b = applyStepEvent(a, { scope: 'step', path: 'revoke', stepId: 'revoke', type: 'graph', status: 'running', attempt: 1 }, 4);
    expect(b.steps).toHaveLength(4);
    expect(b.steps.at(-1)).toMatchObject({ seq: 4, stepId: 'revoke', status: 'running' });
  });

  it('run and progress events patch the run', () => {
    const d = readRunDetail(liveDetail('running'));
    expect(applyRunEvent(d, { scope: 'run', status: 'succeeded' }).run.status).toBe('succeeded');
    expect(applyProgressEvent(d, { path: 'items', done: 2, total: 5 }).run.progress).toEqual({ done: 2, total: 5, failed: undefined });
  });

  it('log lines carry level, step and script output', () => {
    expect(readLog({ id: 7, ts: '2026-10-15T14:00:00Z', stepSeq: 3, level: 'warn', message: 'Throttled', path: 'revoke' }, 'x')).toMatchObject({
      id: '7',
      level: 'warn',
      stepSeq: 3,
      stepId: 'revoke',
      message: 'Throttled',
    });
    expect(readLog({ level: 'info', message: 'Script output', output: { mailboxes: 3 } }, 'y')?.message).toBe('Script output: {"mailboxes":3}');
  });

  it('nested paths group under their top-level step', () => {
    expect(topLevelKey('items[3].run')).toBe('items');
    expect(isNested('items[3].run')).toBe(true);
    expect(isNested('disable#compensate')).toBe(false);
  });
});

describe('timeline', () => {
  it('lists the definition’s steps in order, named from the definition, pending until they run', () => {
    const def = disableUser as unknown as Playbook;
    const entries = buildTimeline(readRunDetail(liveDetail('running')), def);
    expect(entries.map((e) => [e.label, e.status])).toEqual([
      ['Look up the user', 'succeeded'],
      ['Check the account is enabled', 'succeeded'],
      ['Set accountEnabled to false', 'running'],
      ['Revoke refresh tokens and session cookies', 'pending'],
    ]);
    expect(labelOf(stepIndex(def), 'guard')).toBe('Check the account is enabled');
    expect(labelOf(stepIndex(def), '$approval')).toBe('Approval before changes');
  });
});
