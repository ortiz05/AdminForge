import type { DeliveryStatus } from '@adminforge/api/src/delivery/notifier';
import { InProcessRunQueue } from '@adminforge/api/src/runs';
import { mockConfig } from './helpers';
import { AVERY, FakeExecutor, StaticDefinitions } from './runs-helpers';
import { buildTestApp, sessionFor } from './support/app';

// DATA_MODE=fixtures never touches the network (F-20): a run waiting for approval tells the approvers by e-mail and
// Teams. E-mail went through the fixture outbound, but the Teams webhook was posted with the platform fetch, so every
// mock approval request reached the internet. It gets the fixture fetch now, like schedules' delivery.

const notified = vi.hoisted(() => ({ results: [] as Array<Promise<DeliveryStatus[]>> }));
vi.mock('@adminforge/api/src/delivery/notifier', async (importOriginal) => {
  const real = await importOriginal<typeof import('@adminforge/api/src/delivery/notifier')>();
  return {
    ...real,
    notifyApprovers: (...args: Parameters<typeof real.notifyApprovers>) => {
      const p = real.notifyApprovers(...args);
      notified.results.push(p);
      return p;
    },
  };
});

const DELIVERY_ENV = {
  AF_MAIL_SENDER: 'adminforge@example.com',
  AF_APPROVALS_EMAIL: 'approvers@example.com',
  AF_APPROVALS_TEAMS_WEBHOOK:
    'https://example.webhook.office.com/webhookb2/00000000-0000-4000-8000-0000000000f2',
};

function definitions() {
  return new StaticDefinitions().add({
    kind: 'playbook',
    id: 'test.approved-change',
    title: 'An approved change',
    owner: 'tests',
    version: '1.0.0',
    risk: 'low',
    mode: 'write',
    approval: { required: true },
    steps: [
      {
        id: 'change',
        type: 'graph',
        mode: 'write',
        describe: 'Change something',
        request: { method: 'POST', path: '/groups', body: { displayName: 'AF-Test' } },
      },
    ],
  } as never);
}

const platform: string[] = [];
beforeEach(() => {
  platform.length = 0;
  notified.results.length = 0;
  vi.stubGlobal('fetch', async (input: unknown) => {
    platform.push(String(input instanceof Request ? input.url : input));
    throw new TypeError('fetch failed: the network is off in this test');
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('approver notifications in fixtures mode never touch the network', () => {
  it('posts the Teams message and sends the e-mail through the fixtures', async () => {
    const queue = new InProcessRunQueue(undefined, 10);
    const { app, sessions, clock } = await buildTestApp(mockConfig(), {
      deps: {
        // The platform fetch on the context, as `pnpm dev` builds it.
        fetch: globalThis.fetch,
        runs: {
          definitions: definitions(),
          outbound: new FakeExecutor(),
          queue,
          sweep: false,
          delivery: { env: DELIVERY_ENV },
        },
      },
    });
    await app.ready();
    try {
      const avery = await sessionFor({ app, sessions, clock }, AVERY, ['Portal.Reader', 'Portal.Operator'], {
        armed: true,
      });
      const res = await avery.post('/api/runs', { playbook: 'test.approved-change', inputs: {} });
      expect(res.statusCode).toBe(202);
      await queue.drain();
      expect((await avery.get(`/api/runs/${res.json().runId}`)).json().run.status).toBe('awaiting_approval');

      expect(notified.results).toHaveLength(1);
      expect(await notified.results[0]).toEqual([
        { type: 'email', status: 'sent', message: 'Sent to 1 recipient(s).' },
        { type: 'teams', status: 'sent', message: 'Posted to Teams.' },
      ]);
      expect(platform).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
