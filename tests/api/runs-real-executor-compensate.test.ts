import path from 'node:path';
import { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
import { createFixtureFetch } from '@adminforge/connectors';
import { loadContentDir, type Playbook } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';
import { mockConfig } from './helpers';
import { ALL_ROLES, AVERY, runsApp, StaticDefinitions } from './runs-helpers';

// A write playbook end to end through the real outbound executor (policy, declared writes, the Graph connector, its
// error mapping) on the fixture fetch — not a fake (functionality plan F-02 part 2). The published
// identity.disable-user runs against the synthetic AF-Test users: dry run → typed confirmation → run; for
// AF-Test-User-02 revoking sessions fails (a 500 fixture), so `onError: compensate` re-enables the account.
// The fixture fetch here has no `acceptWrites`: every write is answered by a fixture written for it.

const FIXTURES = path.join(repoRoot, 'tests/fixtures');
const USER_01 = { id: '00000000-0000-4000-8000-0000000001a1', upn: 'af-test-user-01@example.com' };
const USER_02 = { id: '00000000-0000-4000-8000-0000000001a2', upn: 'af-test-user-02@example.com' };

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const disableUser = loaded.definitions.find((d) => d.def.id === 'identity.disable-user')!.def as Playbook;

type Call = { method: string; path: string; body: unknown; status: number; fixture?: string };

async function setup() {
  const calls: Call[] = [];
  const pending: Array<{ method: string; path: string; body: unknown }> = [];
  const fixtures = createFixtureFetch(FIXTURES, {
    onRequest: ({ method, url, file, status }) => {
      const at = pending.findIndex((p) => p.method === method && p.path === new URL(url).pathname);
      const [req] = pending.splice(at, 1);
      calls.push({
        method,
        path: new URL(url).pathname,
        body: req?.body,
        status,
        ...(file ? { fixture: file } : {}),
      });
    },
  });
  const recorded = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    pending.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname, body });
    return fixtures(input, init);
  }) as typeof fetch;
  const config = mockConfig();
  const outbound = createOutboundExecutor({
    config,
    broker: null,
    auth: null,
    automation: null,
    fetch: recorded,
    env: () => ({}),
  });
  const t = await runsApp({ config, definitions: new StaticDefinitions().add(disableUser), outbound });
  const avery = await t.login(AVERY, ALL_ROLES, { armed: true });
  const inputs = (id: string) => ({ userId: id, reason: 'incident 4413 compensation test' });
  const preview = async (id: string) => {
    const res = await avery.post('/api/runs', {
      playbook: 'identity.disable-user',
      inputs: inputs(id),
      dryRun: true,
    });
    expect(res.statusCode).toBe(202);
    await t.drain();
    return (await avery.get(`/api/runs/${res.json().runId}`)).json();
  };
  const run = async (id: string, previewRunId: string, confirmation: string) => {
    const res = await avery.post('/api/runs', {
      playbook: 'identity.disable-user',
      inputs: inputs(id),
      previewRunId,
      confirmation,
    });
    return res;
  };
  return { t, avery, calls, preview, run };
}

type Step = { stepId: string; path: string; status: string; error?: { message?: string } | null };
const statuses = (steps: Step[]) => Object.fromEntries(steps.map((s) => [s.path, s.status]));

describe('a write playbook through the real outbound executor on fixtures', () => {
  it('dry run → confirm → run → forced failure → compensate', async () => {
    const { t, avery, calls, preview, run } = await setup();
    try {
      // Dry run: the lookup reads the user; both writes are only planned.
      const dry = await preview(USER_02.id);
      expect(dry.run).toMatchObject({ status: 'succeeded', dryRun: true });
      expect(statuses(dry.steps)).toMatchObject({
        lookup: 'succeeded',
        disable: 'planned',
        revoke: 'planned',
      });
      expect(calls.map((c) => c.method)).toEqual(['GET']);

      // The typed confirmation is the user's sign-in name from the preview: a wrong one is refused, nothing written.
      const wrong = await run(USER_02.id, dry.run.id, USER_01.upn);
      expect(wrong.statusCode).toBe(422);
      expect(calls.map((c) => c.method)).toEqual(['GET']);

      const res = await run(USER_02.id, dry.run.id, USER_02.upn.toUpperCase());
      expect(res.statusCode).toBe(202);
      await t.drain();
      const done = (await avery.get(`/api/runs/${res.json().runId}`)).json();

      // Revoking failed, so the disable was undone: the run ends compensated, not failed half-way.
      expect(done.run).toMatchObject({ status: 'compensated', dryRun: false, previewRunId: dry.run.id });
      expect(statuses(done.steps)).toMatchObject({
        lookup: 'succeeded',
        guard: 'succeeded',
        disable: 'compensated',
        revoke: 'failed',
        'disable#compensate': 'succeeded',
      });
      const revoke = (done.steps as Step[]).find((s) => s.path === 'revoke')!;
      expect(revoke.error?.message).toMatch(/sessions can't be revoked/);

      // What reached "Microsoft": the lookup again, the disable, the failed revoke and the re-enable — in that order,
      // each answered by its fixture.
      const userPath = `/v1.0/users/${USER_02.id}`;
      expect(calls.slice(1)).toEqual([
        {
          method: 'GET',
          path: userPath,
          body: undefined,
          status: 200,
          fixture: expect.stringMatching(/GET\.json$/),
        },
        {
          method: 'PATCH',
          path: userPath,
          body: { accountEnabled: false },
          status: 204,
          fixture: expect.any(String),
        },
        {
          method: 'POST',
          path: `${userPath}/revokeSignInSessions`,
          body: undefined,
          status: 500,
          fixture: expect.any(String),
        },
        {
          method: 'PATCH',
          path: userPath,
          body: { accountEnabled: true },
          status: 204,
          fixture: expect.any(String),
        },
      ]);
      expect(t.audit.rows.some((r) => r.action === 'run.created' && r.targetId === done.run.id)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('runs to the end when nothing fails (the control)', async () => {
    const { t, avery, calls, preview, run } = await setup();
    try {
      const dry = await preview(USER_01.id);
      const res = await run(USER_01.id, dry.run.id, USER_01.upn);
      expect(res.statusCode).toBe(202);
      await t.drain();
      const done = (await avery.get(`/api/runs/${res.json().runId}`)).json();
      expect(done.run).toMatchObject({
        status: 'succeeded',
        outputs: { summary: `Sign-in disabled and sessions revoked for ${USER_01.upn}` },
      });
      expect(calls.map((c) => `${c.method} ${c.status}`)).toEqual([
        'GET 200',
        'GET 200',
        'PATCH 204',
        'POST 200',
      ]);
    } finally {
      await t.close();
    }
  });
});
