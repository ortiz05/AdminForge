import { registryFrom } from '@adminforge/api/src/definitions/registry';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { createJobRunner, type JobContext, type JobDeps } from '@adminforge/api/src/schedules/jobs';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { FakeDefinitions, probe, schedule } from './helpers';

// A probe job reports which synthetic transactions acted on the tenant (the scheduler then audits the run as a
// write): only those that got as far as calling Microsoft — a transaction whose test object isn't configured changed
// nothing and isn't counted.
const NOW = new Date('2026-10-17T12:00:00.000Z');
const USER = '33333333-3333-4333-8333-333333333333';

class FakeOutbound implements OutboundExecutor {
  readonly calls: Array<{ identity: ExecutionIdentity; call: ServiceCall }> = [];
  async execute<T>(identity: ExecutionIdentity, call: ServiceCall) {
    this.calls.push({ identity, call });
    const data =
      call.method === 'POST'
        ? { id: 'meet-1', joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/x' }
        : {};
    return { data: data as T, status: 200, provenance: { service: call.service, path: call.path, ms: 1 } };
  }
}

function run() {
  const defs = new FakeDefinitions()
    .set(probe('probes.meeting', { check: { kind: 'onlineMeeting' }, tags: ['synthetic-transaction'] }))
    .set(
      probe('probes.mail', {
        check: { kind: 'mailFlow' },
        tags: ['synthetic-transaction'],
        timeoutMs: 110_000,
      }),
    );
  const outbound = new FakeOutbound();
  const deps = {
    definitions: registryFrom(defs as never, 'fs'),
    store: new MemoryScheduleStore(() => NOW),
    outbound,
    probes: {
      automation: null,
      connection: async () => Promise.reject(new Error('none')),
      // The meeting's test user is configured, the mail check's test mailbox isn't.
      env: () => ({ AF_SYNTHETIC_USER_ID: USER, AF_MAIL_SENDER: 'reports@example.com' }),
      now: () => NOW,
      fetch: async () => new Response(''),
    },
    now: () => NOW,
    sleep: async () => undefined,
  } as unknown as JobDeps;
  const def = schedule('sweep.synthetic-transactions', {
    job: { kind: 'probe', select: { tags: ['synthetic-transaction'] } },
  });
  const row = { id: 's-1', key: def.id, source: 'content', definition: def, enabled: true } as ScheduleRow;
  const ctx = {
    schedule: row,
    def,
    run: { id: 'r-1', scheduleId: 's-1', scheduleKey: def.id, trigger: 'cron' } as ScheduleRunRow,
    signal: new AbortController().signal,
    correlationId: 'c-1',
    scheduledBy: null,
  } as unknown as JobContext;
  return { result: createJobRunner(deps).run(ctx), outbound };
}

describe('probe jobs with synthetic transactions', () => {
  it('counts only the transactions that acted, with their outcome codes', async () => {
    const { result, outbound } = run();
    const r = await result;
    expect(r.result).toMatchObject({
      probes: 2,
      ok: 1,
      error: 1,
      transactions: 1,
      transactionCodes: { 'probes.meeting': 'ok' },
    });
    expect(outbound.calls.map((c) => `${c.call.method} ${c.identity.mode}`)).toEqual([
      'POST write',
      'DELETE write',
    ]);
  });
});

describe('probe jobs waiting for configuration', () => {
  it('succeed with a note when every probe is only "not configured"', async () => {
    const defs = new FakeDefinitions().set(
      probe('probes.meeting', { check: { kind: 'onlineMeeting' }, tags: ['synthetic-transaction'] }),
    );
    const deps = {
      definitions: registryFrom(defs as never, 'fs'),
      store: new MemoryScheduleStore(() => NOW),
      outbound: new FakeOutbound(),
      probes: {
        automation: null,
        connection: async () => Promise.reject(new Error('none')),
        env: () => ({}),
        now: () => NOW,
        fetch: async () => new Response(''),
      },
      now: () => NOW,
      sleep: async () => undefined,
    } as unknown as JobDeps;
    const def = schedule('sweep.synthetic-transactions', {
      job: { kind: 'probe', select: { tags: ['synthetic-transaction'] } },
    });
    const r = await createJobRunner(deps).run({
      schedule: { id: 's-1', key: def.id, definition: def } as ScheduleRow,
      def,
      run: { id: 'r-1' } as ScheduleRunRow,
      signal: new AbortController().signal,
      correlationId: 'c-1',
      scheduledBy: null,
    } as unknown as JobContext);
    expect(r.status).toBeUndefined();
    expect(r.result).toMatchObject({
      error: 1,
      waiting: expect.stringMatching(/waiting for its configuration/),
    });
    expect(r.result).not.toHaveProperty('transactions');
  });
});
