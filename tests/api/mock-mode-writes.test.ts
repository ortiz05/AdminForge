import { loadConfig } from '@adminforge/api/src/config';
import { fixtureFetch, MOCK_NO_FIXTURE } from '@adminforge/api/src/datasources/services';
import { InProcessRunQueue } from '@adminforge/api/src/runs';
import type { Config } from '@adminforge/api/src/config';
import { entraConfig, mockConfig } from './helpers';
import { buildTestApp, sessionFor } from './support/app';
import { ALL_ROLES, AVERY } from './support/people';

// Write playbooks in mock mode (functionality plan F-02 part 1). With mock sign-in — which config refuses in production,
// off loopback and with any tenant credential — the fixture fetch accepts a write no fixture describes (204: there is no
// tenant to change), so `identity.disable-user` previews, confirms and runs to the end on the synthetic data. A request
// no fixture answers gets a mock-mode message naming no file. Entra sign-in on fixtures is a real person: an unfixtured
// write there stays a 404 and fails the step.

const ADELE = { id: '00000000-0000-4000-8000-000000000101', upn: 'a.lee@example.com' };
const UNKNOWN = '00000000-0000-4000-8000-0000000001ff';

async function app(config: Config) {
  const queue = new InProcessRunQueue(undefined, 10);
  // The published content (portal/content) and the app's own outbound executor on the fixture fetch.
  const t = await buildTestApp(config, { deps: { runs: { queue, sweep: false } } });
  await t.app.ready();
  const avery = await sessionFor(t, AVERY, ALL_ROLES, { armed: true });
  const disable = async (userId: string, confirmation: string) => {
    const preview = await avery.post('/api/runs', {
      playbook: 'identity.disable-user',
      inputs: { userId, reason: 'incident 4412 mock-mode test' },
      dryRun: true,
    });
    expect(preview.statusCode).toBe(202);
    await queue.drain();
    const previewRunId = preview.json().runId as string;
    const previewed = (await avery.get(`/api/runs/${previewRunId}`)).json();
    if (previewed.run.status !== 'succeeded') return { previewed, run: null };
    const res = await avery.post('/api/runs', {
      playbook: 'identity.disable-user',
      inputs: { userId, reason: 'incident 4412 mock-mode test' },
      previewRunId,
      confirmation,
    });
    expect(res.statusCode).toBe(202);
    await queue.drain();
    return { previewed, run: (await avery.get(`/api/runs/${res.json().runId}`)).json() };
  };
  return { ...t, avery, disable };
}

describe('write playbooks with mock sign-in', () => {
  it('previews, confirms and runs identity.disable-user to the end on the fixtures', async () => {
    const t = await app(mockConfig());
    try {
      const { previewed, run } = await t.disable(ADELE.id, ADELE.upn);
      expect(previewed.run.status).toBe('succeeded');
      expect(run.run).toMatchObject({ status: 'succeeded', dryRun: false });
      expect(run.run.outputs).toMatchObject({
        summary: `Sign-in disabled and sessions revoked for ${ADELE.upn}`,
      });
      // The two writes ran (accepted by the fixtures), not planned.
      const writes = (run.steps as Array<{ stepId: string; status: string; mode?: string }>).filter((s) =>
        ['disable', 'revoke'].includes(s.stepId),
      );
      expect(writes.map((s) => [s.stepId, s.status])).toEqual([
        ['disable', 'succeeded'],
        ['revoke', 'succeeded'],
      ]);
    } finally {
      await t.app.close();
    }
  });

  it('answers a request no fixture describes with a mock-mode message that names no file', async () => {
    const t = await app(mockConfig());
    try {
      const { previewed } = await t.disable(UNKNOWN, 'nobody@example.com');
      expect(previewed.run.status).toBe('failed');
      const body = JSON.stringify(previewed);
      expect(body).toContain('Mock mode has no synthetic data for this request.');
      expect(body).not.toMatch(/\.json|fixtures directory|graph\/v1\.0/);
    } finally {
      await t.app.close();
    }
  });
});

describe('the fixture fetch behind the outbound executor', () => {
  const PATCH = { method: 'PATCH', body: JSON.stringify({ accountEnabled: false }) };
  const unfixtured = `https://graph.microsoft.com/v1.0/users/${UNKNOWN}`;

  it('with mock sign-in: accepts an unfixtured write (204) and logs the file to add, never the browser', async () => {
    const warnings: Array<{ obj: object; msg: string }> = [];
    const f = fixtureFetch(mockConfig(), { warn: (obj, msg) => warnings.push({ obj, msg }) });
    expect((await f(unfixtured, PATCH)).status).toBe(204);
    const read = await f(unfixtured);
    expect(read.status).toBe(404);
    expect(await read.json()).toEqual({ error: { code: 'FixtureNotFound', message: MOCK_NO_FIXTURE } });
    expect(warnings).toEqual([
      {
        msg: 'mock mode: no fixture for this request',
        obj: {
          fixture: { method: 'GET', candidates: [`graph/v1.0/users/${UNKNOWN}/GET.json`] },
        },
      },
    ]);
    // A fixture that is there still answers, writes included.
    expect((await f(`https://graph.microsoft.com/v1.0/users/${ADELE.id}`)).status).toBe(200);
  });

  it('with Entra sign-in on fixtures: an unfixtured write stays a 404 (never a silent success)', async () => {
    const f = fixtureFetch(entraConfig({ DATA_MODE: 'fixtures' }));
    const res = await f(unfixtured, PATCH);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('FixtureNotFound');
  });

  it('the fence holds: mock sign-in is refused in production, off loopback and with tenant credentials', () => {
    const base = { PUBLIC_BASE_URL: 'http://localhost:5173', AUTH_MODE: 'mock', DATA_MODE: 'fixtures' };
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', DATABASE_PATH: '/var/lib/adminforge/af.db' }),
    ).toThrow(/mock auth is not allowed in production/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', API_HOST: '0.0.0.0' })).toThrow(
      /only listens on loopback/,
    );
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', DATA_MODE: 'live' })).toThrow(
      /needs DATA_MODE=fixtures/,
    );
  });
});

describe('write playbooks with Entra sign-in on fixtures', () => {
  it('fails the write step on an unfixtured PATCH instead of pretending it worked', async () => {
    const t = await app(entraConfig({ DATA_MODE: 'fixtures' }));
    try {
      const { previewed, run } = await t.disable(ADELE.id, ADELE.upn);
      expect(previewed.run.status).toBe('succeeded');
      expect(run.run.status).toBe('failed');
      const disable = (run.steps as Array<{ stepId: string; status: string }>).find(
        (s) => s.stepId === 'disable',
      );
      expect(disable?.status).toBe('failed');
    } finally {
      await t.app.close();
    }
  });
});
