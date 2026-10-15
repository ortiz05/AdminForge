import { mockConfig } from './helpers';
import { ALL_ROLES, AVERY, BLAKE, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

const UPN = 'a.lee@example.com';
const ENABLED = '00000000-0000-4000-8000-000000000001';
const DISABLED = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

const inputs = { userId: { type: 'string', format: 'guid' }, since: { type: 'date', default: '-7d' } };
const steps = [
  { id: 'lookup', type: 'graph', mode: 'read', request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' } },
  { id: 'guard', type: 'assert', that: '${ steps.lookup.output.enabled = true }', message: 'already disabled' },
  { id: 'disable', type: 'graph', mode: 'write', describe: 'Disable', request: { method: 'PATCH', path: '/users/${ $encode(inputs.userId) }', body: { accountEnabled: false } } },
];
const typed = (version: string, message = "Type the user's sign-in name to confirm.") =>
  ({ kind: 'playbook', id: 'test.typed', version, title: 'Disable (typed)', owner: 't', risk: 'high', mode: 'write', inputs, steps, confirm: { type: 'typed', value: '${ steps.lookup.output.upn }', message } }) as never;

function definitions() {
  return new StaticDefinitions()
    .add(typed('1.0.0'))
    .add({ kind: 'playbook', id: 'test.click', version: '1.0.0', title: 'Disable (click)', owner: 't', risk: 'high', mode: 'write', inputs, steps, confirm: { type: 'click', message: '${ "Disable " & steps.lookup.output.upn & "?" }' } } as never)
    .add({ kind: 'playbook', id: 'test.leaky', version: '1.0.0', title: 'Leaky', owner: 't', risk: 'high', mode: 'write', inputs, steps, confirm: { type: 'typed', value: '${ steps.lookup.output.upn }', message: '${ "Type " & steps.lookup.output.upn }' } } as never)
    .add({ kind: 'playbook', id: 'test.none', version: '1.0.0', title: 'No confirm', owner: 't', risk: 'low', mode: 'write', inputs, steps, confirm: { type: 'none' } } as never);
}

async function setup() {
  const defs = definitions();
  const t = await runsApp({
    config: mockConfig(),
    definitions: defs,
    outbound: new FakeExecutor((c) => (c.method === 'GET' ? { upn: UPN, enabled: !c.path.endsWith(DISABLED) } : null)),
  });
  const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
  const preview = async (playbook = 'test.typed', userId = ENABLED, who = avery) => {
    const res = await who.post('/api/runs', { playbook, inputs: { userId }, dryRun: true });
    expect(res.statusCode).toBe(202);
    await t.drain();
    return res.json().runId as string;
  };
  const run = (body: Record<string, unknown>, who = avery) => who.post('/api/runs', { playbook: 'test.typed', inputs: { userId: ENABLED }, dryRun: false, ...body });
  return { t, defs, avery, preview, run };
}

/** No error body may ever contain the value the person has to type. */
const noLeak = (res: { body: string }) => expect(res.body.toLowerCase()).not.toContain(UPN);

describe('preview then confirm (server-side typed confirmation)', () => {
  it('requires a preview to execute a playbook with a confirm block (typed or click); dry runs and confirm: none do not', async () => {
    const { t, avery, run } = await setup();
    const missing = await run({ confirmation: UPN });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatchObject({ code: 'preview_required', message: 'Preview this change first — the confirmation is based on what the preview found.' });
    expect((await avery.post('/api/runs', { playbook: 'test.click', inputs: { userId: ENABLED } })).json().error.code).toBe('preview_required');
    expect((await avery.post('/api/runs', { playbook: 'test.typed', inputs: { userId: ENABLED }, dryRun: true })).statusCode).toBe(202);
    expect((await avery.post('/api/runs', { playbook: 'test.none', inputs: { userId: ENABLED } })).statusCode).toBe(202);
    expect((await run({ previewRunId: 'not-a-uuid' })).statusCode).toBe(400);
    await t.drain();
    await t.close();
  });

  it('matches the typed confirmation (trimmed, case-insensitive) and records the preview on the run and in the audit', async () => {
    const { t, avery, preview, run } = await setup();
    const previewRunId = await preview();
    const res = await run({ previewRunId, confirmation: `  ${UPN.toUpperCase()} ` });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    await t.drain();
    const detail = (await avery.get(`/api/runs/${runId}`)).json();
    expect(detail.run).toMatchObject({ status: 'succeeded', dryRun: false, previewRunId });
    expect((await avery.get(`/api/runs/${previewRunId}`)).json().run.previewRunId).toBeNull();
    expect(t.outbound.calls.filter((c) => c.call.method === 'PATCH')).toHaveLength(1);
    const created = t.audit.rows.filter((r) => r.action === 'run.created' && r.targetId === runId);
    expect(created[0]!.details).toMatchObject({ previewRunId, confirm: 'typed', confirmationMatched: true, dryRun: false });
    expect(JSON.stringify(created)).not.toContain(UPN.toUpperCase());
    await t.close();
  });

  it('refuses a mismatch (or a missing confirmation) with the author’s message and never the expected value', async () => {
    const { t, preview, run } = await setup();
    const previewRunId = await preview();
    for (const confirmation of ['b.other@example.com', undefined, '', 'a.lee@example']) {
      const res = await run({ previewRunId, ...(confirmation === undefined ? {} : { confirmation }) });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'confirmation_mismatch', message: "Type the user's sign-in name to confirm." });
      noLeak(res);
    }
    expect(t.outbound.calls.filter((c) => c.call.method === 'PATCH')).toHaveLength(0);
    await t.close();
  });

  it('falls back to a generic message when the author’s message would reveal the value', async () => {
    const { t, avery, preview } = await setup();
    const previewRunId = await preview('test.leaky');
    const res = await avery.post('/api/runs', { playbook: 'test.leaky', inputs: { userId: ENABLED }, previewRunId, confirmation: 'nope' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("The confirmation doesn't match.");
    noLeak(res);
    await t.close();
  });

  it('refuses stale previews: other inputs, version, person, age, status, not a dry run, unknown id', async () => {
    const { t, defs, avery, preview, run } = await setup();
    const ok = await preview();
    const stale = async (res: Awaited<ReturnType<typeof run>>, why: RegExp) => {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('preview_stale');
      expect(res.json().error.message).toMatch(why);
      noLeak(res);
    };
    await stale(await avery.post('/api/runs', { playbook: 'test.typed', inputs: { userId: OTHER }, previewRunId: ok, confirmation: UPN }), /different inputs/);
    await stale(await avery.post('/api/runs', { playbook: 'test.click', inputs: { userId: ENABLED }, previewRunId: ok }), /playbook changed/);
    // Another person's preview.
    const blake = await t.login(BLAKE, ALL_ROLES, { armed: true });
    await stale(await run({ previewRunId: ok, confirmation: UPN }, blake), /not your preview/);
    // A preview that failed (the guard refused).
    const failed = await preview('test.typed', DISABLED);
    await stale(await avery.post('/api/runs', { playbook: 'test.typed', inputs: { userId: DISABLED }, previewRunId: failed, confirmation: UPN }), /failed/);
    // A real (non-dry) run is not a preview.
    const real = (await run({ previewRunId: ok, confirmation: UPN })).json().runId;
    await t.drain();
    await stale(await run({ previewRunId: real, confirmation: UPN }), /not a dry run/);
    await stale(await run({ previewRunId: '00000000-0000-4000-8000-00000000dead', confirmation: UPN }), /not your preview/);
    // A newer version was published since the preview.
    defs.add(typed('1.1.0'));
    await stale(await run({ previewRunId: ok, confirmation: UPN }), /playbook changed/);
    const fresh = await preview();
    // Older than 15 minutes.
    t.clock.advance(15 * 60_000 + 1);
    await stale(await run({ previewRunId: fresh, confirmation: UPN }), /older than 15 minutes/);
    await t.close();
  });

  it('click confirms need only the preview; relative defaults resolve as previewed', async () => {
    const { t, avery, preview } = await setup();
    const previewRunId = await preview('test.click');
    t.clock.advance(5 * 60_000); // `since: -7d` would now resolve differently — the preview's value is used
    const res = await avery.post('/api/runs', { playbook: 'test.click', inputs: { userId: ENABLED }, previewRunId });
    expect(res.statusCode).toBe(202);
    await t.drain();
    const [p, r] = await Promise.all([t.repository.getRun(previewRunId), t.repository.getRun(res.json().runId)]);
    expect(r!.inputs).toEqual(p!.inputs);
    expect(t.audit.rows.find((x) => x.action === 'run.created' && x.targetId === r!.id)!.details).toMatchObject({ previewRunId, confirm: 'click', confirmationMatched: false });
    await t.close();
  });
});

describe('preview then confirm: bulk', () => {
  it('needs a dry-run bulk preview with identical items, and the number of items as the confirmation', async () => {
    const { t, avery } = await setup();
    const items = [{ userId: ENABLED }, { userId: OTHER }];
    const bulk = (body: Record<string, unknown>) => avery.post('/api/runs/bulk', { playbook: 'test.typed', items, inputsTemplate: {}, ...body });
    expect((await bulk({})).json().error.code).toBe('preview_required');
    const previewRunId = (await bulk({ dryRun: true })).json().runId;
    await t.drain();
    expect((await t.repository.getRun(previewRunId))!.status).toBe('succeeded');
    const wrong = await bulk({ previewRunId, confirmation: '3' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error).toMatchObject({ code: 'confirmation_mismatch', message: 'Type the number of items to confirm this change.' });
    const other = await avery.post('/api/runs/bulk', { playbook: 'test.typed', items: [{ userId: ENABLED }], previewRunId, confirmation: '1' });
    expect(other.json().error.code).toBe('preview_stale');
    // An interactive preview is not a bulk preview.
    const single = (await avery.post('/api/runs', { playbook: 'test.typed', inputs: { userId: ENABLED }, dryRun: true })).json().runId;
    await t.drain();
    expect((await bulk({ previewRunId: single, confirmation: '2' })).json().error.code).toBe('preview_stale');
    const ok = await bulk({ previewRunId, confirmation: ' 2 ' });
    expect(ok.statusCode).toBe(202);
    await t.drain();
    const detail = (await avery.get(`/api/runs/${ok.json().runId}`)).json();
    expect(detail.run).toMatchObject({ trigger: 'bulk', status: 'succeeded', previewRunId, outputs: { total: 2, succeeded: 2 } });
    expect(t.audit.rows.find((x) => x.action === 'run.created' && x.targetId === ok.json().runId)!.details).toMatchObject({ previewRunId, confirmationMatched: true, items: 2 });
    await t.close();
  });
});
