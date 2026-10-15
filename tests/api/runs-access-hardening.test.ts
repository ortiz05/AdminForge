import type { Schedule } from '@adminforge/schemas';
import { mockConfig } from './helpers';
import {
  ALL_ROLES,
  AVERY,
  BLAKE,
  CASEY,
  DREW,
  FakeExecutor,
  runsApp,
  StaticDefinitions,
} from './runs-helpers';

// Who may see, decide on and feed values into runs (M6, M7, L4, L5, L6).
const USER = '00000000-0000-4000-8000-000000000001';
const base = { owner: 'tests', version: '1.0.0' } as const;
const lookup = {
  id: 'lookup',
  type: 'graph',
  mode: 'read',
  request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
};
const disable = {
  id: 'disable',
  type: 'graph',
  mode: 'write',
  describe: 'Disable sign-in',
  request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } },
};

function definitions() {
  return (
    new StaticDefinitions()
      // Read-only, Reader-gated: what a scheduled report-style playbook looks like.
      .add({
        kind: 'playbook',
        id: 'test.read-only',
        title: 'Read only',
        risk: 'low',
        mode: 'read',
        requires: { portalRoles: ['Portal.Reader'] },
        inputs: { userId: { type: 'string', format: 'guid' } },
        steps: [lookup],
        ...base,
      } as never)
      // Operator-gated; the steps after the approval run as the approver.
      .add({
        kind: 'playbook',
        id: 'test.guarded',
        title: 'Guarded lookup',
        risk: 'low',
        mode: 'read',
        requires: { portalRoles: ['Portal.Operator'] },
        inputs: { userId: { type: 'string', format: 'guid' } },
        steps: [{ id: 'approve', type: 'approval', message: 'Look up?' }, lookup],
        ...base,
      } as never)
      .add({
        kind: 'playbook',
        id: 'test.approved',
        title: 'Approved disable',
        risk: 'low',
        mode: 'write',
        inputs: { userId: { type: 'string', format: 'guid' } },
        steps: [lookup, { id: 'approve', type: 'approval', message: 'Disable?' }, disable],
        ...base,
      } as never)
      // A manual step collecting a secret (`redact: true`) that a later write step sends after another pause.
      .add({
        kind: 'runbook',
        id: 'test.secret-runbook',
        title: 'Set a code',
        risk: 'low',
        mode: 'write',
        outputs: { code: '${ steps.echo.output }' },
        sections: [
          {
            id: 's1',
            title: 'Collect',
            body: 'Ask',
            steps: [
              {
                id: 'ask',
                type: 'manual',
                instructions: 'Agree a code with the user',
                inputs: { ticket: { type: 'string' }, code: { type: 'string', redact: true } },
              },
              { id: 'echo', type: 'transform', expression: '${ steps.ask.output.values.code }' },
              { id: 'done', type: 'manual', instructions: 'Tell the user' },
              {
                id: 'send',
                type: 'graph',
                mode: 'write',
                describe: 'Set the code',
                request: { method: 'PATCH', path: '/users/x', body: { code: '${ steps.echo.output }' } },
              },
            ],
          },
        ],
        ...base,
      } as never)
      .add({
        kind: 'playbook',
        id: 'test.draft',
        title: 'Draft change',
        status: 'draft',
        risk: 'low',
        mode: 'write',
        inputs: { userId: { type: 'string', format: 'guid' } },
        steps: [lookup, disable],
        ...base,
      } as never)
      // Parent that starts an Admin-only child.
      .add({
        kind: 'playbook',
        id: 'test.admin-child',
        title: 'Admin-only lookup',
        risk: 'low',
        mode: 'read',
        requires: { portalRoles: ['Portal.Admin'] },
        inputs: { userId: { type: 'string', format: 'guid' } },
        steps: [lookup],
        ...base,
      } as never)
      .add({
        kind: 'playbook',
        id: 'test.parent',
        title: 'Parent',
        risk: 'low',
        mode: 'read',
        inputs: { userId: { type: 'string', format: 'guid' } },
        steps: [
          {
            id: 'child',
            type: 'playbook',
            ref: 'test.admin-child',
            inputs: { userId: '${ inputs.userId }' },
          },
        ],
        ...base,
      } as never)
  );
}

async function setup() {
  return runsApp({
    config: mockConfig(),
    definitions: definitions(),
    outbound: new FakeExecutor((c) => (c.method === 'GET' ? { id: USER, upn: 'a.lee@example.com' } : null)),
  });
}

describe('manual steps: values come only from the person the step waits for (M6, L4)', () => {
  it('another Operator may decline but not fill in values; the initiator can', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const drew = await t.login(DREW, ['Portal.Operator'], { armed: true });
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.secret-runbook', inputs: {} })).json();
    await t.drain();
    const res = await drew.post(`/api/runs/${runId}/manual/ask`, {
      confirmed: true,
      values: { ticket: 'INC-1', code: 'Planted-1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'not_your_step',
      hint: expect.stringContaining(AVERY.upn),
    });
    // Confirming without values on a step that takes values is the same thing.
    expect((await drew.post(`/api/runs/${runId}/manual/ask`, { confirmed: true })).statusCode).toBe(403);
    expect((await drew.post(`/api/runs/${runId}/manual/ask`, { confirmed: false })).json()).toEqual({
      status: 'rejected',
    });
    await t.close();
  });

  it('values typed into redact fields are masked in the task, step outputs, run outputs, events and audit — and reach the write after a pause', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const { runId } = (await avery.post('/api/runs', { playbook: 'test.secret-runbook', inputs: {} })).json();
    await t.drain();
    const ok = await avery.post(`/api/runs/${runId}/manual/ask`, {
      confirmed: true,
      values: { ticket: 'INC-7', code: 'S3cret-42' },
    });
    expect(ok.json()).toEqual({ status: 'approved' });
    await t.drain();
    expect((await avery.get(`/api/runs/${runId}`)).json().run.status).toBe('awaiting_input');
    // The run paused: the next pass rebuilds `echo` from the stored (masked) record.
    await avery.post(`/api/runs/${runId}/manual/done`, { confirmed: true });
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run.status).toBe('succeeded');
    expect(t.outbound.calls.at(-1)!.call.body).toEqual({ code: 'S3cret-42' });
    expect(detail.run.outputs).toEqual({ code: '[redacted]' });
    const ask = detail.tasks.find((x: { stepId: string }) => x.stepId === 'ask');
    expect(ask.decisions[0].values).toEqual({ ticket: 'INC-7', code: '[redacted]' });
    expect(detail.steps.find((s: { stepId: string }) => s.stepId === 'echo').output).toBe('[redacted]');
    expect(JSON.stringify(detail)).not.toContain('S3cret-42');
    const events = await t.repository.listEvents(runId, 0, 1000);
    expect(JSON.stringify(events)).not.toContain('S3cret-42');
    const audit = t.audit.rows.find((r) => r.action === 'run.manual.confirmed' && r.details?.step === 'ask');
    expect(audit!.details).toMatchObject({ values: { ticket: 'INC-7', code: '[redacted]' } });
    expect(JSON.stringify(t.audit.rows)).not.toContain('S3cret-42');
    await t.close();
  });
});

describe('approvals (L6)', () => {
  it('the steps after an approval run as the approver, who needs the playbook’s roles', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator']);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.guarded', inputs: { userId: USER } })
    ).json();
    await t.drain();
    const blake = await t.login(BLAKE, ['Playbook.Approver']);
    const refused = await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/run as you.*Portal\.Operator/);
    // Rejecting needs no roles beyond Approver: nothing runs as the person who rejects.
    const casey = await t.login(CASEY, ['Playbook.Approver', 'Portal.Operator']);
    expect(
      (await casey.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).json(),
    ).toEqual({
      status: 'approved',
      approvals: 1,
      required: 1,
    });
    await t.close();
  });
});

describe('scheduled runs (automation identity) are visible to the schedule’s roles (M7, L5)', () => {
  async function scheduled(requires?: Schedule['requires']) {
    const t = await setup();
    const row = (await t.app.schedules.store.insertSchedule({
      key: 'ops.nightly',
      source: 'content',
      definition: {
        kind: 'schedule',
        id: 'ops.nightly',
        title: 'Nightly',
        ...(requires ? { requires } : {}),
      } as never,
      sha256: 'x',
      enabled: false,
      nextRunAt: null,
    }))!;
    const run = await t.runs.service.createScheduledRun({
      schedule: { id: row.id, key: row.key, createdBy: 'content (owner: tests)' },
      playbook: 'test.read-only',
      inputs: { userId: USER },
    });
    await t.drain();
    return { t, run };
  }

  it('Approver or Admin without Operator can’t open or list them; Operators with the playbook’s roles can', async () => {
    const { t, run } = await scheduled();
    for (const roles of [['Playbook.Approver'], ['Portal.Admin', 'Portal.Reader'], ['Portal.Operator']]) {
      const who = await t.login(BLAKE, roles);
      expect((await who.get(`/api/runs/${run.id}`)).statusCode).toBe(404);
      expect((await who.get(`/api/runs/${run.id}/events`)).statusCode).toBe(404);
      if (
        roles.includes('Portal.Operator') ||
        roles.includes('Playbook.Approver') ||
        roles.includes('Portal.Admin')
      )
        expect(JSON.stringify((await who.get('/api/runs?scope=all')).json())).not.toContain(run.id);
    }
    const op = await t.login(DREW, ['Portal.Operator', 'Portal.Reader']);
    expect((await op.get(`/api/runs/${run.id}`)).statusCode).toBe(200);
    expect((await op.get('/api/runs?scope=all')).json().items.map((i: { id: string }) => i.id)).toContain(
      run.id,
    );
    await t.close();
  });

  it('a schedule’s requires.portalRoles decides instead of the Operator default', async () => {
    const { t, run } = await scheduled({ portalRoles: ['Portal.Reader'] });
    const reader = await t.login(CASEY, ['Portal.Reader']);
    expect((await reader.get(`/api/runs/${run.id}`)).statusCode).toBe(200);
    const op = await t.login(DREW, ['Portal.Operator']);
    expect((await op.get(`/api/runs/${run.id}`)).statusCode).toBe(404);
    await t.close();
  });

  it('whoever pressed Run now can’t approve the gates of that run', async () => {
    const t = await setup();
    const approvedTarget = await t.runs.service.fingerprint({ ref: 'test.approved' });
    const run = await t.runs.service.createScheduledRun({
      schedule: {
        key: 'ops.disable',
        createdBy: AVERY.upn,
        requestedByOid: AVERY.oid,
        approvedBy: [BLAKE.oid],
        approvedTarget,
      },
      playbook: 'test.approved',
      inputs: { userId: USER },
    });
    expect(run).toMatchObject({ initiatorOid: AVERY.oid, initiatorUpn: AVERY.upn });
    await t.drain();
    const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
    const own = await avery.post(`/api/runs/${run.id}/approvals/approve`, { decision: 'approve' });
    expect(own.statusCode).toBe(403);
    expect(own.json().error.code).toBe('own_run');
    // A different approver may decide without being able to open the run's data.
    const blake = await t.login(BLAKE, ['Playbook.Approver'], { armed: true });
    expect((await blake.get(`/api/runs/${run.id}`)).statusCode).toBe(404);
    expect(
      (await blake.post(`/api/runs/${run.id}/approvals/approve`, { decision: 'approve' })).json(),
    ).toEqual({
      status: 'approved',
      approvals: 1,
      required: 1,
    });
    await t.close();
  });
});

describe('what may run (L6)', () => {
  it('a draft can be previewed but not run', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Operator'], { armed: true });
    const dry = await avery.post('/api/runs', {
      playbook: 'test.draft',
      inputs: { userId: USER },
      dryRun: true,
    });
    expect(dry.statusCode).toBe(202);
    const real = await avery.post('/api/runs', { playbook: 'test.draft', inputs: { userId: USER } });
    expect(real.statusCode).toBe(409);
    expect(real.json().error).toMatchObject({
      code: 'definition_draft',
      hint: expect.stringMatching(/Preview/),
    });
    await t.close();
  });

  it('a child playbook needs its own roles from whoever the parent runs as', async () => {
    const t = await setup();
    const avery = await t.login(AVERY, ['Portal.Reader']);
    const { runId } = (
      await avery.post('/api/runs', { playbook: 'test.parent', inputs: { userId: USER } })
    ).json();
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run).toMatchObject({
      status: 'failed',
      error: { code: 'forbidden', message: expect.stringMatching(/Portal\.Admin role/) },
    });
    expect(t.outbound.calls).toEqual([]);
    const admin = await t.login(DREW, ['Portal.Reader', 'Portal.Admin']);
    const ok = (await admin.post('/api/runs', { playbook: 'test.parent', inputs: { userId: USER } })).json();
    await t.drain();
    expect((await admin.get(`/api/runs/${ok.runId}`)).json().run.status).toBe('succeeded');
    await t.close();
  });
});

describe('child playbooks never start with a masked value (M11)', () => {
  it('inputs built from a masked output after a pause are refused before the child run exists', async () => {
    const SECRET = 'S3cret-Pass-42';
    const defs = new StaticDefinitions()
      .add({
        kind: 'playbook',
        id: 'test.child-echo',
        title: 'Child',
        risk: 'low',
        mode: 'read',
        inputs: { value: { type: 'string' } },
        steps: [lookup],
        ...base,
      } as never)
      .add({
        kind: 'playbook',
        id: 'test.parent-secret',
        title: 'Parent with a secret',
        risk: 'low',
        mode: 'read',
        inputs: { userId: { type: 'string', format: 'guid' }, password: { type: 'string', redact: true } },
        steps: [
          lookup,
          { id: 'approve', type: 'approval', message: 'Go?' },
          {
            id: 'child',
            type: 'playbook',
            ref: 'test.child-echo',
            inputs: { value: '${ steps.lookup.output.v }', userId: '${ inputs.userId }' },
          },
        ],
        ...base,
      } as never);
    const t = await runsApp({
      config: mockConfig(),
      definitions: defs,
      outbound: new FakeExecutor(() => ({ v: `prefix-${SECRET}` })),
    });
    const avery = await t.login(AVERY, ['Portal.Operator']);
    const { runId } = (
      await avery.post('/api/runs', {
        playbook: 'test.parent-secret',
        inputs: { userId: USER, password: SECRET },
      })
    ).json();
    await t.drain();
    const blake = await t.login(BLAKE, ['Playbook.Approver']);
    expect(
      (await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve' })).statusCode,
    ).toBe(200);
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run.status).toBe('failed');
    expect(detail.steps.find((s: { stepId: string }) => s.stepId === 'child').error).toMatchObject({
      code: 'redacted_value',
    });
    expect(detail.children).toEqual([]);
    await t.close();
  });
});
