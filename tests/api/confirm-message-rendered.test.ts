import { mockConfig } from './helpers';
import { ALL_ROLES, AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// The playbook confirm dialog showed a templated `confirm.message` raw (`${ … }`): the browser printed the definition's
// text. The API now renders the message and the value to type from the preview's step outputs, returns them with the
// preview (GET /api/runs/:id → run.confirm, for the person who previewed), and the browser shows that. The value is
// what the API compares the typed confirmation with, through the same comparison the browser uses.

const USER = '00000000-0000-4000-8000-000000000001';
const UPN = 'a.lee@example.com';
/** An app name with an invisible character and a Cyrillic look-alike (escapes: nothing hidden in this source). */
const SHADY = 'PDF\u{200b} Convert\u{435}r';

const inputs = {
  userId: { type: 'string', format: 'guid' },
  pin: { type: 'string', redact: true },
};
const steps = [
  {
    id: 'lookup',
    type: 'graph',
    mode: 'read',
    request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
  },
  {
    id: 'disable',
    type: 'graph',
    mode: 'write',
    describe: 'Disable',
    request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } },
  },
];
const playbook = (id: string, confirm: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    kind: 'playbook',
    id,
    version: '1.0.0',
    title: id,
    owner: 't',
    risk: 'high',
    mode: 'write',
    inputs,
    steps,
    confirm,
    ...extra,
  }) as never;

function definitions() {
  return new StaticDefinitions()
    .add(
      playbook('test.typed', {
        type: 'typed',
        value: '${ steps.lookup.output.upn }',
        message:
          "${ 'Disable ' & steps.lookup.output.displayName & ' (' & steps.lookup.output.upn & ')? Type the sign-in name to confirm.' }",
      }),
    )
    .add(
      playbook('test.click', {
        type: 'click',
        message: "${ 'Disable ' & steps.lookup.output.displayName & '?' }",
      }),
    )
    .add(
      playbook('test.static', { type: 'typed', value: '${ steps.lookup.output.upn }', message: 'Type it.' }),
    )
    .add(
      playbook('test.broken', {
        type: 'typed',
        value: '${ steps.lookup.output.missing }',
        message: '${ steps.lookup.output.missing }',
      }),
    )
    .add(
      playbook('test.secret', {
        type: 'click',
        message: "${ 'Set the PIN to ' & inputs.pin & '?' }",
      }),
    )
    .add(playbook('test.shady', { type: 'typed', value: '${ steps.lookup.output.app }' }));
}

async function setup() {
  const t = await runsApp({
    config: mockConfig(),
    definitions: definitions(),
    outbound: new FakeExecutor((c) =>
      c.method === 'GET' ? { upn: UPN, displayName: 'Adele Lee', app: SHADY } : null,
    ),
  });
  const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
  const preview = async (playbookKey: string, extra: Record<string, unknown> = {}) => {
    const res = await avery.post('/api/runs', {
      playbook: playbookKey,
      inputs: { userId: USER, pin: '482913', ...extra },
      dryRun: true,
    });
    expect(res.statusCode).toBe(202);
    await t.drain();
    return res.json().runId as string;
  };
  const confirmOf = async (runId: string, who = avery) => {
    const res = await who.get(`/api/runs/${runId}`);
    expect(res.statusCode).toBe(200);
    return res.json().run.confirm as unknown;
  };
  return { t, avery, preview, confirmOf };
}

describe('the preview carries the rendered confirmation', () => {
  it('renders a templated message and the value to type from the preview’s step outputs', async () => {
    const { t, preview, confirmOf } = await setup();
    const id = await preview('test.typed');
    expect(await confirmOf(id)).toEqual({
      type: 'typed',
      value: UPN,
      message: 'Disable Adele Lee (a.lee@example.com)? Type the sign-in name to confirm.',
    });
    expect(await confirmOf(await preview('test.click'))).toEqual({
      type: 'click',
      value: null,
      message: 'Disable Adele Lee?',
    });
    expect(await confirmOf(await preview('test.static'))).toEqual({
      type: 'typed',
      value: UPN,
      message: 'Type it.',
    });
    await t.close();
  });

  it('a template that doesn’t render gives no message and no value — and the API refuses to confirm it', async () => {
    const { t, avery, preview, confirmOf } = await setup();
    const id = await preview('test.broken');
    expect(await confirmOf(id)).toEqual({ type: 'typed', value: null, message: null });
    const res = await avery.post('/api/runs', {
      playbook: 'test.broken',
      inputs: { userId: USER, pin: '482913' },
      previewRunId: id,
      confirmation: 'anything',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('preview_stale');
    await t.close();
  });

  it('never shows a message that would reveal a `redact: true` input', async () => {
    const { t, avery, preview, confirmOf } = await setup();
    const id = await preview('test.secret');
    expect(await confirmOf(id)).toEqual({ type: 'click', value: null, message: null });
    expect((await avery.get(`/api/runs/${id}`)).body).not.toContain('482913');
    await t.close();
  });

  it('only the person who previewed gets it, and only for a finished, succeeded top-level preview', async () => {
    const { t, avery, preview, confirmOf } = await setup();
    const id = await preview('test.typed');
    // Another Operator may see the run, but never what to type to confirm it (only its initiator can).
    const blake = await t.login(BLAKE, ALL_ROLES, { armed: true });
    const theirs = await blake.get(`/api/runs/${id}`);
    if (theirs.statusCode === 200) expect(theirs.json().run.confirm).toBeNull();
    // The real run that the preview confirms carries none.
    const run = await avery.post('/api/runs', {
      playbook: 'test.typed',
      inputs: { userId: USER, pin: '482913' },
      previewRunId: id,
      confirmation: UPN,
    });
    expect(run.statusCode).toBe(202);
    await t.drain();
    expect(await confirmOf(run.json().runId)).toBeNull();
    await t.close();
  });

  it('the value shown is the one the API accepts: case, spacing and invisible characters don’t count, look-alikes do', async () => {
    const { t, avery, preview, confirmOf } = await setup();
    const id = await preview('test.shady');
    expect(await confirmOf(id)).toEqual({ type: 'typed', value: SHADY, message: null });
    const confirm = (confirmation: string) =>
      avery.post('/api/runs', {
        playbook: 'test.shady',
        inputs: { userId: USER, pin: '482913' },
        previewRunId: id,
        confirmation,
      });
    // Latin "e" for the Cyrillic one: no match, and the hint says why look-alikes matter.
    const latin = await confirm('PDF Converter');
    expect(latin.statusCode).toBe(422);
    expect(latin.json().error).toMatchObject({
      code: 'confirmation_mismatch',
      message: "The confirmation doesn't match.",
      hint: 'Type the text shown in the dialog. Case, extra spaces and invisible characters don’t matter; letters from another alphabet that only look the same do, so copy the text when the dialog says it has any.',
    });
    expect(latin.body).not.toContain('Convert');
    const ok = await confirm('  pdf   CONVERT\u{435}R ');
    expect(ok.statusCode).toBe(202);
    await t.close();
  });
});
