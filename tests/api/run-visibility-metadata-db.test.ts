import { createDatabase } from '@adminforge/api/src/db/client';
import { SqliteRunRepository } from '@adminforge/api/src/runs';
import { testDatabasePath } from './db';
import { mockConfig } from './helpers';
import { AVERY, BLAKE, CASEY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// S-25 on the SQLite run repository: the access decision reads the run's ancestors and approval rows from the
// database, and the stream replays stored events through the metadata view.

const file = await testDatabasePath();
const USER = '00000000-0000-4000-8000-000000000001';
const REASON = 'Ticket INC-5151 for a.lee';
const FOUND = 'a.lee@example.com';
const COMMENT = 'Checked with HR, INC-5151';

const definitions = () =>
  new StaticDefinitions()
    .add({
      kind: 'playbook',
      id: 'test.lookup',
      version: '1.0.0',
      title: 'Look up a user',
      owner: 'tests',
      risk: 'low',
      mode: 'read',
      inputs: { userId: { type: 'string', format: 'guid' }, reason: { type: 'string' } },
      outputs: { upn: '${ steps.lookup.output.upn }' },
      steps: [
        {
          id: 'lookup',
          type: 'graph',
          mode: 'read',
          request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
        },
      ],
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.parent',
      version: '1.0.0',
      title: 'Approved parent',
      owner: 'tests',
      risk: 'low',
      mode: 'read',
      inputs: { userId: { type: 'string', format: 'guid' }, reason: { type: 'string' } },
      steps: [
        { id: 'approve', type: 'approval', message: 'Look up for ${ inputs.reason }?' },
        {
          id: 'child',
          type: 'playbook',
          ref: 'test.lookup',
          inputs: { userId: '${ inputs.userId }', reason: '${ inputs.reason }' },
        },
      ],
    } as never);

describe('run visibility on SQLite (S-25)', () => {
  it('approver, initiator and bystander each see what they may, from stored rows and events', async () => {
    // The app closes its database on close: give it its own connection.
    const appDb = createDatabase(file);
    const t = await runsApp({
      config: mockConfig({ DATABASE_PATH: file }),
      definitions: definitions(),
      outbound: new FakeExecutor(() => ({ id: USER, upn: FOUND })),
      database: appDb,
      repository: new SqliteRunRepository(appDb),
    });
    try {
      const avery = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator']);
      const blake = await t.login(BLAKE, ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver']);
      const casey = await t.login(CASEY, ['Portal.Reader', 'Portal.Operator']);
      const { runId } = (
        await avery.post('/api/runs', { playbook: 'test.parent', inputs: { userId: USER, reason: REASON } })
      ).json();
      await t.drain();

      expect((await blake.get(`/api/runs/${runId}`)).json().run).toMatchObject({
        status: 'awaiting_approval',
        access: 'full',
        inputs: { reason: REASON },
      });
      expect((await casey.get(`/api/runs/${runId}`)).json().run).toMatchObject({
        status: 'awaiting_approval',
        access: 'metadata',
        inputs: {},
      });

      await blake.post(`/api/runs/${runId}/approvals/approve`, { decision: 'approve', comment: COMMENT });
      await t.drain();
      const parent = (await avery.get(`/api/runs/${runId}`)).json();
      expect(parent.run.status).toBe('succeeded');
      const childId = parent.children[0].id as string;

      // The child ran as the approver; the parent's initiator and the approver see it whole, a bystander doesn't.
      for (const who of [avery, blake])
        expect((await who.get(`/api/runs/${childId}`)).json().run).toMatchObject({
          access: 'full',
          outputs: { upn: FOUND },
        });
      for (const id of [runId, childId]) {
        const seen = (await casey.get(`/api/runs/${id}`)).json();
        expect(seen.run).toMatchObject({ access: 'metadata', inputs: {}, outputs: null });
        const text = JSON.stringify(seen);
        for (const m of [REASON, FOUND, COMMENT]) expect(text).not.toContain(m);
        const sse = (await casey.get(`/api/runs/${id}/events`)).body;
        expect(sse).toContain('event: end');
        expect(sse).not.toContain('"type":"log"');
        for (const m of [REASON, FOUND, COMMENT]) expect(sse).not.toContain(m);
      }
      expect((await avery.get(`/api/runs/${runId}/events`)).body).toContain(COMMENT);
    } finally {
      await t.close();
    }
  });
});
