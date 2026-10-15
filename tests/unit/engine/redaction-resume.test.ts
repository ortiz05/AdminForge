import { escapeMarkdown } from '@adminforge/engine';
import { APPROVER, harness, INITIATOR, playbook, read, runbook, write } from './helpers';

// Values of `redact: true` inputs are masked wherever a run is stored or shown (L4), and a pause never turns them
// into the literal "[redacted]" in what is sent afterwards (M11).
const SECRET = 'S3cret-Pass-42';
const inputs = { password: { type: 'string', redact: true }, name: { type: 'string', required: false } };
const approval = { id: 'approve', type: 'approval', message: 'Go?' };

describe('engine: secrets in run outputs, errors and events (L4)', () => {
  it('run outputs and the run error never hold a redact value', async () => {
    const ok = harness(playbook([read('lookup')], { inputs, outputs: { echo: '${ inputs.password }' } }), {
      inputs: { password: SECRET },
    });
    expect((await ok.exec()).status).toBe('succeeded');
    expect((await ok.run()).outputs).toEqual({ echo: '[redacted]' });

    const failing = harness(
      playbook(
        [{ id: 'check', type: 'assert', that: '${ false }', message: '${ "bad " & inputs.password }' }],
        {
          inputs,
        },
      ),
      { inputs: { password: SECRET } },
    );
    expect((await failing.exec()).status).toBe('failed');
    expect((await failing.run()).error).toMatchObject({ code: 'assertion_failed', message: '[redacted]' });
    expect(JSON.stringify(failing.store.events)).not.toContain(SECRET);
    expect(JSON.stringify(await failing.all())).not.toContain(SECRET);
  });

  it('values typed into a manual step’s redact fields are masked from then on', async () => {
    const def = runbook([
      {
        id: 's',
        title: 'S',
        steps: [
          {
            id: 'ask',
            type: 'manual',
            instructions: 'Agree a code',
            inputs: { code: { type: 'string', redact: true } },
          },
          { id: 'echo', type: 'transform', expression: '${ steps.ask.output.values.code }' },
        ],
      },
    ]);
    const h = harness(def);
    expect((await h.exec()).status).toBe('awaiting_input');
    h.store.decide('run-1', 'ask', {
      kind: 'manual',
      confirmed: true,
      actor: INITIATOR,
      notes: null,
      values: { code: SECRET },
      decidedAt: h.clock.now().toISOString(),
    });
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.record('ask')!.output).toMatchObject({ values: { code: '[redacted]' } });
    expect(h.record('echo')!.output).toBe('[redacted]');
    expect(JSON.stringify(h.store.events)).not.toContain(SECRET);
  });
});

describe('engine: after a pause, later steps get real values, never "[redacted]" (M11)', () => {
  it('a pure step computed from a secret is recomputed for the steps after an approval', async () => {
    const def = playbook(
      [
        {
          id: 'body',
          type: 'transform',
          expression: '${ { "passwordProfile": { "password": inputs.password } } }',
        },
        approval,
        write('reset', { request: { method: 'PATCH', path: '/users/x', body: '${ steps.body.output }' } }),
      ],
      { inputs },
    );
    const h = harness(def, { inputs: { password: SECRET } });
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('awaiting_approval');
    // What was stored is masked.
    expect(JSON.stringify(h.record('body')!.output)).not.toContain(SECRET);
    h.approve('approve');
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.at(-1)!.call.body).toEqual({ passwordProfile: { password: SECRET } });
  });

  it('forEach items holding a secret are evaluated again', async () => {
    const def = playbook(
      [
        {
          id: 'each',
          type: 'forEach',
          items: '${ [inputs.password] }',
          steps: [
            approval,
            write('set', { request: { method: 'PATCH', path: '/x', body: { v: '${ item }' } } }),
          ],
        },
      ],
      { inputs },
    );
    const h = harness(def, { inputs: { password: SECRET } });
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('awaiting_approval');
    h.approve('each[0].approve');
    expect((await h.exec()).status).toBe('succeeded');
    expect(h.outbound.calls.at(-1)!.call.body).toEqual({ v: SECRET });
  });

  it('a service output that was masked is never sent on: the step fails with a clear error and sends nothing', async () => {
    const def = playbook(
      [
        read('lookup'),
        approval,
        write('copy', {
          request: { method: 'PATCH', path: '/users/x', body: { value: '${ steps.lookup.output.v }' } },
        }),
      ],
      { inputs },
    );
    const h = harness(def, {
      inputs: { password: SECRET },
      respond: (c) => (c.method === 'GET' ? { v: `prefix-${SECRET}` } : null),
    });
    h.identity.signIn(APPROVER, true);
    expect((await h.exec()).status).toBe('awaiting_approval');
    h.approve('approve');
    expect((await h.exec()).status).toBe('failed');
    expect(h.record('copy')!.error).toMatchObject({
      code: 'redacted_value',
      message: expect.stringContaining('nothing was sent'),
      hint: expect.stringMatching(/Run the playbook again/),
    });
    expect(h.outbound.calls.filter((c) => c.call.method === 'PATCH')).toEqual([]);
  });
});

describe('engine: Markdown fields escape the values they interpolate (L1)', () => {
  it('approval messages and manual instructions show data as text, never as links or markup', async () => {
    const hostile = '[Open](/\\evil.example.com) **now**\n# Heading';
    const def = playbook(
      [{ id: 'approve', type: 'approval', message: 'Disable **${ inputs.name }**?' }, write('w')],
      { inputs },
    );
    const h = harness(def, { inputs: { password: SECRET, name: hostile } });
    expect((await h.exec()).status).toBe('awaiting_approval');
    const task = [...h.store.tasks.values()][0] as { message: string };
    expect(task.message).toBe(`Disable **${escapeMarkdown(hostile)}**?`);
    expect(task.message).toContain('\\[Open\\]\\(/\\\\evil.example.com\\)');
    expect(task.message).toContain('\n\\# Heading');
  });

  it('escapeMarkdown leaves plain text alone and escapes inline and line-start markup', () => {
    expect(escapeMarkdown('Avery Lee (IT)')).toBe('Avery Lee \\(IT\\)');
    expect(escapeMarkdown('a.lee@example.com')).toBe('a.lee@example.com');
    expect(escapeMarkdown('- item\n1. one\n> quote')).toBe('\\- item\n1\\. one\n\\> quote');
    expect(escapeMarkdown('`code` _x_ *y*')).toBe('\\`code\\` \\_x\\_ \\*y\\*');
  });
});
