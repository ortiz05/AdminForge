import { flattenSteps, Step, stepMode, walkSteps, type Playbook, type Runbook } from '@adminforge/schemas';
import { brief, ENVELOPE, errors, ok, yaml } from './helpers';

const head = (risk = 'low', mode = 'write') =>
  `${ENVELOPE('playbook', 'identity.example')}risk: ${risk}\nmode: ${mode}\n`;
// head() is 7 lines; `steps:` is line 8, the first step's `- id` line 9.

describe('playbook', () => {
  it('accepts every step type, nested branch/forEach, compensation and tests', () => {
    const def = ok<Playbook>(
      head() +
        yaml`
        inputs:
          userIds: { type: user, multiple: true, label: Users }
        steps:
          - { id: lookup, type: graph, request: { path: "/users/\${ $encode(inputs.id) }" }, paging: none }
          - { id: counts, type: graphBatch, requests: { a: { path: /users/$count } } }
          - { id: rgs, type: arm, request: { path: /subscriptions, apiVersion: 2022-12-01 } }
          - { id: arc, type: resourceGraph, query: resources }
          - { id: logs, type: logAnalytics, workspace: "\${ env.AF_WORKSPACE_ID }", query: "AppRequests | take 1" }
          - { id: hr, type: function, connection: integrations.hr-sync, operation: listEmployees }
          - { id: ps, type: runner, script: exchange/Get-Thing.ps1, sha256: ${'ab'.repeat(32)} }
          - { id: hook, type: http, mode: write, describe: Tell the ticketing system, request: { method: POST, url: "https://tickets.example.com/api/notes", body: { a: 1 } } }
          - { id: shape, type: transform, expression: "\${ steps.lookup.output.id }" }
          - { id: check, type: assert, that: "\${ steps.lookup.output.accountEnabled }", message: Already disabled }
          - id: maybe
            type: branch
            if: "\${ inputs.force }"
            then:
              - { id: approve, type: approval, approvers: [Playbook.Approver], minApprovals: 1, expiresIn: PT4H }
            else:
              - { id: confirm, type: manual, instructions: "Call the user", checklist: [Called] }
          - id: each
            type: forEach
            items: "\${ inputs.userIds }"
            as: userId
            concurrency: 5
            steps:
              - id: disable
                type: graph
                mode: write
                describe: Disable
                retry: { max: 3, backoff: exponential, delay: 2s }
                onError: compensate
                idempotent: true
                dryRunOutput: { ok: true }
                request: { method: PATCH, path: "/users/\${ $encode(userId) }", body: { accountEnabled: false } }
                compensate: { type: graph, describe: Re-enable, request: { method: PATCH, path: "/users/\${ $encode(userId) }", body: { accountEnabled: true } } }
          - { id: pause, type: wait, duration: 30s }
          - { id: until, type: wait, until: "\${ steps.lookup.output.ready }", interval: 1m, timeout: PT10M }
          - { id: tell, type: notify, mode: write, describe: Email the owner, channel: email, to: "\${ user.upn }", subject: Done, message: "All done" }
          - { id: child, type: playbook, ref: identity.revoke-sessions, inputs: { userId: "\${ inputs.id }" } }
        outputs:
          summary: "\${ 'done' }"
        tests:
          - name: refuses when already disabled
            inputs: { id: 00000000-0000-4000-8000-000000000001 }
            mocks: { lookup: { accountEnabled: false } }
            errors: { hr: { status: 503 } }
            expect: { status: failed, failedStep: check, plan: [disable], steps: { lookup: succeeded } }
      `,
    );
    const ids: string[] = [];
    walkSteps(def.steps, (s) => ids.push(s.id));
    expect(ids).toEqual([
      'lookup',
      'counts',
      'rgs',
      'arc',
      'logs',
      'hr',
      'ps',
      'hook',
      'shape',
      'check',
      'maybe',
      'approve',
      'confirm',
      'each',
      'disable',
      'pause',
      'until',
      'tell',
      'child',
    ]);
    expect(stepMode(def.steps[0]!)).toBe('read');
    const each = def.steps.find((s) => s.type === 'forEach');
    expect(
      each?.type === 'forEach' && each.steps[0]!.type === 'graph' && each.steps[0]!.compensate?.type,
    ).toBe('graph');
  });

  it.each([
    [
      'forEach concurrency above 10',
      "- { id: e, type: forEach, items: '${ [1] }', concurrency: 11, steps: [{ id: t, type: transform, expression: '${ 1 }' }] }",
      'steps[0].concurrency@9',
      /<=10/,
    ],
    [
      'forEach over 1000 items',
      "- { id: e, type: forEach, items: '${ [1] }', maxItems: 1001, steps: [{ id: t, type: transform, expression: '${ 1 }' }] }",
      'steps[0].maxItems@9',
      /<=1000/,
    ],
    ['an unknown step type', '- { id: x, type: sql }', 'steps[0].type@9', /Expected 'graph' \| 'graphBatch'/],
    [
      'a step id with a dash',
      '- { id: my-step, type: transform, expression: "${ 1 }" }',
      'steps[0].id@9',
      /letters, digits and _/,
    ],
    [
      'PATCH without mode: write',
      '- { id: x, type: graph, request: { method: PATCH, path: /users/1, body: {} } }',
      'steps[0].mode@9',
      /PATCH changes data/,
    ],
    [
      'POST without an explicit mode',
      '- { id: x, type: graph, request: { method: POST, path: /users/1/revokeSignInSessions } }',
      'steps[0].mode@9',
      /explicitly/,
    ],
    [
      'a write step without describe',
      '- { id: x, type: graph, mode: write, request: { method: DELETE, path: /groups/1 } }',
      'steps[0].describe@9',
      /need describe/,
    ],
    [
      'notify without mode: write',
      '- { id: x, type: notify, channel: email, to: a@example.com, message: hi }',
      'steps[0].mode@9',
      /notify sends a message/,
    ],
    [
      'an http step with an expression host',
      "- { id: x, type: http, request: { url: 'https://${ env.HOST }/x' } }",
      'steps[0].request.url@9',
      /literal host/,
    ],
    [
      'a wait step with both duration and until',
      "- { id: x, type: wait, duration: 5s, until: '${ true }' }",
      'steps[0].duration@9',
      /exactly one of duration or until/,
    ],
    [
      'an assert without ${ }',
      '- { id: x, type: assert, that: a = b, message: m }',
      'steps[0].that@9',
      /single \$\{ … \} expression/,
    ],
  ])('rejects %s', (_label, step, at, message) => {
    const e = errors(`${head()}steps:\n  ${step}\n`);
    expect(brief(e)).toEqual([at]);
    expect(e[0]!.message).toMatch(message);
  });

  it('rejects duplicate step ids, including nested ones', () => {
    const e = errors(
      `${head()}steps:\n  - { id: a, type: transform, expression: "\${ 1 }" }\n  - id: b\n    type: branch\n    if: "\${ true }"\n    then:\n      - { id: a, type: transform, expression: "\${ 2 }" }\n`,
    );
    expect(e).toEqual([
      {
        file: 'test.yaml',
        path: 'steps[1].then[0].id',
        line: 14,
        message: 'Duplicate step id "a" (also at steps.0).',
      },
    ]);
  });
  it('rejects write steps in a read-only playbook', () =>
    expect(
      errors(
        `${head('low', 'read')}steps:\n  - { id: x, type: graph, mode: write, describe: d, request: { method: PATCH, path: /users/1 } }\n`,
      )[0]!.message,
    ).toMatch(/top-level mode: write/));
  it('requires confirmation at high risk and approval at critical risk', () => {
    const step = 'steps:\n  - { id: x, type: transform, expression: "${ 1 }" }\n';
    expect(brief(errors(head('high') + step))).toEqual(['confirm@1']);
    expect(brief(errors(head('critical') + step))).toEqual(['confirm@1', 'approval@1']);
    expect(
      ok(
        `${head('critical')}confirm: { type: typed, value: "\${ inputs.upn }" }\napproval: { required: true, approvers: [Playbook.Approver], minApprovals: 2, expiresIn: PT4H }\n${step}`,
      ),
    ).toBeTruthy();
    expect(brief(errors(`${head('high')}confirm: { type: typed }\n${step}`))).toEqual(['confirm.value@8']);
  });
  it('checks that tests refer to real steps', () => {
    const e = errors(
      `${head()}steps:\n  - { id: x, type: transform, expression: "\${ 1 }" }\ntests:\n  - { name: t, mocks: { y: 1 }, expect: { status: failed, failedStep: z } }\n`,
    );
    expect(e.map((x) => [x.path, x.message])).toEqual([
      ['tests[0].mocks.y', 'Unknown step id "y".'],
      ['tests[0].expect', 'Unknown step id "z".'],
    ]);
    expect(e[0]!.line).toBe(11);
  });
  it('requires at least one step', () => expect(brief(errors(`${head()}steps: []\n`))).toEqual(['steps@8']));
  it('parses steps on their own', () => {
    expect(
      Step.safeParse({
        id: 'a',
        type: 'forEach',
        items: '${ [1] }',
        steps: [{ id: 'b', type: 'wait', duration: '1s' }],
      }).success,
    ).toBe(true);
    expect(Step.safeParse({ id: 'a', type: 'forEach', items: '${ [1] }', steps: [] }).success).toBe(false);
  });
});

describe('runbook', () => {
  const rb = `${ENVELOPE('runbook', 'incident.compromised-account')}risk: high\nmode: write\nconfirm: { type: click }\n`;
  it('interleaves Markdown sections with steps', () => {
    const def = ok<Runbook>(
      rb +
        yaml`
        inputs:
          userId: { type: user }
        sections:
          - id: triage
            title: Triage
            body: |
              Confirm the report with the user's manager before acting on \${ inputs.userId }.
            steps:
              - { id: confirmed, type: manual, instructions: Manager confirmed the report, checklist: [Ticket linked] }
          - id: contain
            title: Contain
            body: Disable sign-in, then revoke sessions.
            steps:
              - { id: disable, type: playbook, mode: write, describe: Disable sign-in, ref: identity.disable-user, inputs: { userId: "\${ inputs.userId }" } }
          - id: notes
            title: Follow-up
            body: Record the outcome in the ticket.
      `,
    );
    expect(def.sections.map((s) => s.id)).toEqual(['triage', 'contain', 'notes']);
    expect(flattenSteps(def).map((s) => s.id)).toEqual(['confirmed', 'disable']);
  });
  it('checks step ids across sections and rejects top-level steps', () => {
    const dup = errors(
      `${rb}sections:\n  - { id: a, title: A, steps: [{ id: s, type: wait, duration: 1s }] }\n  - { id: b, title: B, steps: [{ id: s, type: wait, duration: 1s }] }\n`,
    );
    expect(dup[0]).toMatchObject({
      path: 'sections[1].steps[0].id',
      line: 11,
      message: expect.stringMatching(/Duplicate step id "s"/),
    });
    expect(errors(`${rb}sections: [{ id: a, title: A }]\nsteps: []\n`)[0]!.message).toBe(
      'Unrecognized key: "steps"',
    );
  });
});
