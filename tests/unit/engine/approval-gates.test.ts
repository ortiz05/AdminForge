import { DEFAULT_APPROVAL_EXPIRES_IN, parseDuration } from '@adminforge/schemas';
import { harness, playbook, read, write } from './helpers';

// Approval gates: who the change grants access to can't approve it (ENG-02), and every request expires (ENG-11).
const BENEFICIARY = '00000000-0000-4000-8000-0000000000C3';
const MEMBER = '00000000-0000-4000-8000-0000000000d4';

const task = (h: ReturnType<typeof harness>) => [...h.store.tasks.values()][0] as Record<string, unknown>;

describe('engine: approval excludes (ENG-02)', () => {
  it('evaluates `excludes` as the gate opens: ids lower-cased, lists flattened, empties and duplicates dropped', async () => {
    const def = playbook([
      read('members', '/groups/g/members'),
      {
        id: 'approve',
        type: 'approval',
        excludes: '${ [inputs.principalId, steps.members.output.value.id, null, ""] }',
      },
      write('grant'),
    ]);
    const h = harness(def, {
      inputs: { principalId: BENEFICIARY },
      respond: () => ({ value: [{ id: MEMBER }, { id: BENEFICIARY }] }),
    });
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(task(h).excludes).toEqual([BENEFICIARY.toLowerCase(), MEMBER]);
    // Stored on the waiting record too, so re-opening the task after a restart keeps it.
    expect((h.record('approve')!.request as { excludes: string[] }).excludes).toEqual([
      BENEFICIARY.toLowerCase(),
      MEMBER,
    ]);
  });

  it('the implicit gate of approval: { required: true } carries approval.excludes', async () => {
    const def = playbook([read('lookup'), write('grant')], {
      risk: 'critical',
      confirm: { type: 'click' },
      approval: { required: true, excludes: '${ inputs.principalId }' },
    });
    const h = harness(def, { inputs: { principalId: BENEFICIARY } });
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(task(h)).toMatchObject({ path: '$approval', excludes: [BENEFICIARY.toLowerCase()] });
  });

  it('a gate without excludes has none', async () => {
    const h = harness(playbook([{ id: 'approve', type: 'approval' }, write('grant')]));
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(task(h)).not.toHaveProperty('excludes');
  });

  it('an excludes that yields something other than ids fails the gate instead of opening it', async () => {
    const def = playbook([{ id: 'approve', type: 'approval', excludes: '${ { "id": 1 } }' }, write('grant')]);
    const h = harness(def);
    const out = await h.exec();
    expect(out.status).toBe('failed');
    expect(out.error).toMatchObject({ code: 'approval_excludes_invalid', stepId: 'approve' });
    expect(h.store.tasks.size).toBe(0);
    expect(h.outbound.calls).toHaveLength(0);
  });

  it('a preview (dry run) checks excludes too, so a broken expression shows up before anyone runs it', async () => {
    const def = playbook([{ id: 'approve', type: 'approval', excludes: '${ 42 }' }, write('grant')]);
    const h = harness(def, { dryRun: true });
    expect((await h.exec()).error).toMatchObject({ code: 'approval_excludes_invalid' });
    const ok = harness(
      playbook([{ id: 'approve', type: 'approval', excludes: '${ "x" }' }, write('grant')]),
      {
        dryRun: true,
      },
    );
    expect((await ok.exec()).status).toBe('succeeded');
    expect(ok.status('approve')).toBe('skipped');
  });
});

describe('engine: approval expiry (ENG-11)', () => {
  it('a gate without expiresIn expires after the default (72 hours)', async () => {
    expect(parseDuration(DEFAULT_APPROVAL_EXPIRES_IN)).toBe(72 * 3_600_000);
    const h = harness(playbook([{ id: 'approve', type: 'approval' }, write('grant')]));
    expect((await h.exec()).status).toBe('awaiting_approval');
    expect(task(h).expiresAt).toBe(new Date(h.clock.now().getTime() + 72 * 3_600_000).toISOString());
    h.clock.advance(72 * 3_600_000);
    expect((await h.exec()).error).toMatchObject({ code: 'approval_expired' });
    expect(h.outbound.calls).toHaveLength(0);
  });

  it('an explicit expiresIn (step, then approval block) still wins', async () => {
    const step = harness(
      playbook([{ id: 'approve', type: 'approval', expiresIn: 'PT1H' }, write('grant')], {
        approval: { required: false, expiresIn: 'P7D' },
      }),
    );
    await step.exec();
    expect(task(step).expiresAt).toBe(new Date(step.clock.now().getTime() + 3_600_000).toISOString());
    const block = harness(
      playbook([{ id: 'approve', type: 'approval' }, write('grant')], {
        approval: { required: false, expiresIn: 'P7D' },
      }),
    );
    await block.exec();
    expect(task(block).expiresAt).toBe(new Date(block.clock.now().getTime() + 7 * 86_400_000).toISOString());
  });
});
