import {
  extractSecrets,
  isSecretMarker,
  runPlaybookTests,
  secretHint,
  secretSpec,
  type RunnerPort,
  type SecretDelivery,
  type SecretSink,
} from '@adminforge/engine';
import { Playbook } from '@adminforge/schemas';
import { harness, playbook, read } from './helpers';

const TAP = 'TapValue-7Q9x!';
const CLIENT_SECRET = 'cs~0123456789abcdefghijKLMN';

/** A sink that keeps what it was given (tests only). */
function sink(status: 'delivered' | 'held' | 'sent' | 'discarded' = 'delivered') {
  const got: SecretDelivery[] = [];
  const s: SecretSink = { deliver: async (_run, d) => (got.push(d), { status }) };
  return { got, s };
}

const createTap = (extra: Record<string, unknown> = {}) => ({
  id: 'create',
  type: 'graph',
  mode: 'write',
  describe: 'Create a TAP',
  request: {
    method: 'POST',
    path: '/users/u/authentication/temporaryAccessPassMethods',
    body: { lifetimeInMinutes: 60 },
  },
  secretOutputs: ['temporaryAccessPass'],
  ...extra,
});

describe('extractSecrets', () => {
  it('masks declared paths (with * and indexes), keeps the rest, and returns the values once', () => {
    const out = {
      id: 'm1',
      temporaryAccessPass: TAP,
      creds: [
        { secretText: CLIENT_SECRET, keyId: 'k1' },
        { secretText: null, keyId: 'k2' },
      ],
      nested: { a: { pw: 'p' } },
    };
    const r = extractSecrets(
      out,
      secretSpec({
        secretOutputs: ['temporaryAccessPass', 'creds.*.secretText', 'nested.a.pw', 'missing.path'],
      }),
    );
    expect(r.masked).toEqual({
      id: 'm1',
      temporaryAccessPass: { $secret: true, hint: '14 characters' },
      creds: [
        { secretText: { $secret: true, hint: '…KLMN' }, keyId: 'k1' },
        { secretText: null, keyId: 'k2' },
      ],
      nested: { a: { pw: { $secret: true, hint: '1 characters' } } },
    });
    expect(r.values).toEqual({
      temporaryAccessPass: TAP,
      'creds.0.secretText': CLIENT_SECRET,
      'nested.a.pw': 'p',
    });
    expect(out.temporaryAccessPass).toBe(TAP); // the input is not mutated
    expect(extractSecrets(r.masked, secretSpec({ secretOutputs: ['temporaryAccessPass'] })).values).toEqual(
      {},
    ); // markers are not secrets
  });

  it('secret: true masks the whole output; nothing to mask yields no values', () => {
    expect(extractSecrets({ a: 1 }, secretSpec({ secret: true }))).toEqual({
      masked: { $secret: true, hint: 'object' },
      values: { $: { a: 1 } },
      hints: { $: 'object' },
    });
    expect(extractSecrets(null, secretSpec({ secret: true })).values).toEqual({});
    expect(extractSecrets({ a: 1 }, null)).toEqual({ masked: { a: 1 }, values: {}, hints: {} });
    expect(secretSpec({})).toBeNull();
    expect(secretHint('x'.repeat(40))).toBe('…xxxx');
    expect(isSecretMarker({ $secret: true, hint: 'x' })).toBe(true);
  });
});

describe('schema: secrets cannot flow into expressions', () => {
  const parse = (steps: unknown[], extra: Record<string, unknown> = {}) =>
    Playbook.safeParse({
      kind: 'playbook',
      id: 'test.secrets',
      version: '1.0.0',
      title: 'T',
      owner: 't',
      risk: 'low',
      mode: 'write',
      steps,
      ...extra,
    });
  const messages = (r: ReturnType<typeof parse>) =>
    r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  it('refuses later steps, outputs and compensations that read a secret path', () => {
    const r = parse(
      [
        createTap({
          compensate: {
            type: 'graph',
            request: { method: 'DELETE', path: '/x/${ steps.create.output.temporaryAccessPass }' },
          },
        }),
        { id: 'leak', type: 'transform', expression: '${ steps.create.output.temporaryAccessPass }' },
        {
          id: 'leak2',
          type: 'transform',
          expression: '${ $lookup(steps.create.output, "temporaryAccessPass") }',
        },
      ],
      {
        outputs: { tap: '${ steps.create.output . temporaryAccessPass }', ok: '${ steps.create.output.id }' },
      },
    );
    expect(
      messages(r)
        .map((m) => m.split(': ')[0])
        .sort(),
    ).toEqual(['outputs.tap', 'steps.0.compensate.request.path', 'steps.1.expression', 'steps.2.expression']);
    expect(messages(r)[0]).toMatch(
      /steps\.create\.output\.temporaryAccessPass is a show-once secret; it is shown to the person who ran the playbook and cannot be used in expressions or outputs\.$/,
    );
  });

  it('allows non-secret fields, the parent object, and test data; secret: true blocks every output reference', () => {
    expect(
      parse(
        [
          createTap(),
          { id: 'ok', type: 'transform', expression: '${ [steps.create.output.id, steps.create.output] }' },
        ],
        {
          tests: [
            { name: 't', mocks: { create: { temporaryAccessPass: 'x' } }, expect: { status: 'succeeded' } },
          ],
        },
      ).success,
    ).toBe(true);
    const whole = parse([
      { ...read('vault'), secret: true },
      { id: 'x', type: 'transform', expression: '${ steps.vault.output.anything }' },
    ]);
    expect(messages(whole)[0]).toMatch(/^steps\.1\.expression: steps\.vault\.output is a show-once secret/);
    expect(parse([createTap({ secretOutputs: ['bad path!'] })]).success).toBe(false);
    expect(parse([createTap({ secretOutputs: ['creds.*.secretText', 'a.0.b'] })]).success).toBe(true);
  });
});

describe('engine: show-once secrets', () => {
  const def = playbook(
    [
      createTap(),
      // A dynamic lookup slips past the static check: the run-time scope still only has the marker.
      {
        id: 'sneaky',
        type: 'transform',
        expression: '${ $lookup(steps.create.output, $join(["temporary", "AccessPass"])) }',
      },
      {
        id: 'copy',
        type: 'graph',
        mode: 'write',
        describe: 'Copy',
        request: { method: 'PATCH', path: '/elsewhere', body: { value: '${ steps.sneaky.output }' } },
      },
    ],
    { outputs: { expires: '${ steps.create.output.lifetimeInMinutes }' } },
  );

  it('masks the value everywhere it is kept, and hands it to the sink exactly once', async () => {
    const { got, s } = sink();
    const h = harness(def, {
      engine: { secrets: s },
      respond: (c) =>
        c.method === 'POST' ? { id: 'tap-1', temporaryAccessPass: TAP, lifetimeInMinutes: 60 } : null,
    });
    expect((await h.exec()).status).toBe('succeeded');
    expect(got).toEqual([
      {
        runId: 'run-1',
        stepId: 'create',
        stepPath: 'create',
        values: { temporaryAccessPass: TAP },
        hints: { temporaryAccessPass: '14 characters' },
        producedBy: expect.objectContaining({ oid: expect.any(String) }),
        producedAt: expect.any(String),
      },
    ]);
    expect(h.record('create')?.output).toEqual({
      id: 'tap-1',
      temporaryAccessPass: { $secret: true, hint: '14 characters' },
      lifetimeInMinutes: 60,
    });
    expect(h.record('sneaky')?.output).toEqual({ $secret: true, hint: '14 characters' });
    expect(h.outbound.calls[1]!.call.body).toEqual({ value: { $secret: true, hint: '14 characters' } });
    expect((await h.run()).outputs).toEqual({ expires: 60 });
    // Nothing the store holds — records, saves, events, run row — contains the value.
    expect(
      JSON.stringify([
        h.store.runs,
        [...h.store.steps.values()].map((m) => [...m.values()]),
        h.store.saves,
        h.store.events,
      ]),
    ).not.toContain(TAP);
    expect(h.store.events.find((e) => e.data.secret)?.data).toEqual({
      message: 'Secret output ready. It is shown once to the person who started the run and is not stored.',
      path: 'create',
      secret: {
        runId: 'run-1',
        stepId: 'create',
        stepPath: 'create',
        fields: ['temporaryAccessPass'],
        hints: { temporaryAccessPass: '14 characters' },
        status: 'delivered',
      },
    });
    // Re-executing the finished run does not deliver again.
    await h.exec();
    expect(got).toHaveLength(1);
  });

  it('dry runs mask dryRunOutput/mocks and deliver nothing', async () => {
    const { got, s } = sink();
    const h = harness(
      playbook([createTap({ dryRunOutput: { temporaryAccessPass: 'not-real', lifetimeInMinutes: 60 } })]),
      { dryRun: true, engine: { secrets: s } },
    );
    await h.exec();
    expect(got).toEqual([]);
    expect(h.record('create')?.output).toEqual({
      temporaryAccessPass: { $secret: true, hint: '8 characters' },
      lifetimeInMinutes: 60,
    });
  });

  it('without a sink (or when it fails) the secret is discarded with a warning and the step still succeeds', async () => {
    const respond = () => ({ temporaryAccessPass: TAP });
    const none = harness(playbook([createTap()]), { respond });
    expect((await none.exec()).status).toBe('succeeded');
    expect(none.store.events.find((e) => e.data.secret)).toMatchObject({
      level: 'warn',
      data: {
        message: 'A secret output could not be delivered and was discarded: No secret channel is configured.',
      },
    });
    const failing = harness(playbook([createTap()]), {
      respond,
      engine: { secrets: { deliver: async () => Promise.reject(new Error('stream gone')) } },
    });
    expect((await failing.exec()).status).toBe('succeeded');
    expect(failing.store.events.find((e) => e.data.secret)?.data.message).toMatch(/discarded: stream gone/);
    expect(JSON.stringify([none.store.saves, failing.store.saves])).not.toContain(TAP);
  });

  it('masks streamed runner output events and the final output of a secret: true script step', async () => {
    const runner: RunnerPort = {
      async run(_i, _job, { onEvent }) {
        await onEvent({ type: 'output', data: { password: 'Script-Pw-1' } });
        return { status: 'succeeded', output: { password: 'Script-Pw-1' } };
      },
    };
    const { got, s } = sink();
    const h = harness(
      playbook([
        {
          id: 'ps',
          type: 'runner',
          mode: 'write',
          describe: 'Reset',
          script: 'x/New-Pw.ps1',
          sha256: 'c'.repeat(64),
          secret: true,
        },
      ]),
      { engine: { runner, secrets: s } },
    );
    await h.exec();
    expect(got[0]!.values).toEqual({ $: { password: 'Script-Pw-1' } });
    expect(h.store.events.find((e) => e.type === 'output')?.data).toEqual({
      data: { $secret: true, hint: 'object' },
    });
    expect(JSON.stringify([h.store.saves, h.store.events])).not.toContain('Script-Pw-1');
  });
});

describe('content tests report secrets without keeping them', () => {
  it('non-dry tests deliver to the test sink (field names only in the result)', async () => {
    const def = playbook([createTap()], {
      tests: [
        {
          name: 'live',
          dryRun: false,
          mocks: { create: { temporaryAccessPass: TAP } },
          expect: { status: 'succeeded', steps: { create: 'succeeded' } },
        },
      ],
    });
    const [r] = await runPlaybookTests(def);
    expect(r).toMatchObject({
      passed: true,
      secrets: [{ stepPath: 'create', fields: ['temporaryAccessPass'] }],
    });
    expect(JSON.stringify(r)).not.toContain(TAP);
  });
});
