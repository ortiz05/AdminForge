import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '@adminforge/api/src/artifacts/store';
import { DatasourceRunner } from '@adminforge/api/src/datasources/executor';
import { registryFrom } from '@adminforge/api/src/definitions/registry';
import { createJobRunner, type JobContext } from '@adminforge/api/src/schedules/jobs';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { ScheduleRow, ScheduleRunRow } from '@adminforge/api/src/schedules/types';
import { FakeDefinitions, FakeOutbound, probe, schedule } from './schedules-helpers';

// ADR-015: synthetic transactions send, upload or create on their test objects, so a schedule that runs them doesn't
// run while it is turned off. Run now refuses up front, but a run queued while the schedule was on and claimed after
// it was switched off reaches the job as file-only (F-10): the probe job then holds the transactions back and runs
// only the ordinary probes (2026-10-22 security review). Synthetic data only.
const NOW = new Date('2026-10-22T12:00:00.000Z');
const MAILBOX = 'af-test-mailflow@example.com';
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SENDER = 'af-test-sender@example.com';
const ACCOUNT = '00000000-0000-4000-8000-0000000000e1';

function runner(opts: { onlyTx?: boolean } = {}) {
  const defs = new FakeDefinitions().set(
    probe('probes.mail-flow', {
      check: { kind: 'mailFlow', from: '${ env.AF_SYNTHETIC_SENDER }', to: '${ env.AF_SYNTHETIC_MAILBOX }' },
      tags: ['tx'],
      timeoutMs: 110_000,
    }),
  );
  if (!opts.onlyTx) defs.set(probe('probes.graph', { tags: ['tx'] }));
  const registry = registryFrom(defs as never, 'fs');
  // Account lookups (GET /users?$filter=mail eq …) answer with one account, everything else with an empty list.
  // Reading the message back fails, so a transaction that got as far as sending ends there.
  const outbound = new FakeOutbound((call) => {
    if (call.method === 'GET' && call.path === '/users') return { value: [{ id: ACCOUNT }] };
    if (call.path.includes('/messages')) throw new Error('stop after sending');
    return { value: [] };
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'af-tx-held-'));
  dirs.push(dir);
  const jobs = createJobRunner({
    definitions: registry,
    store: new MemoryScheduleStore(() => NOW),
    outbound,
    probes: {
      automation: null,
      connection: async () => Promise.reject(new Error('none')),
      env: () => ({ AF_SYNTHETIC_MAILBOX: MAILBOX, AF_SYNTHETIC_SENDER: SENDER }),
      now: () => NOW,
      fetch: async () => new Response(''),
    },
    datasources: new DatasourceRunner({ definitions: registry, outbound, env: () => ({}), now: () => NOW }),
    artifacts: new ArtifactStore(dir),
    runs: null,
    automationClientId: null,
    exportMaxRows: 1000,
    now: () => NOW,
    sleep: async () => undefined,
  });
  return { jobs, outbound };
}

function ctxFor(fileOnly: boolean, select: string[] = ['tx']): JobContext {
  const def = schedule('sweep.synthetic-transactions', { job: { kind: 'probe', select: { tags: select } } });
  return {
    schedule: {
      id: 's1',
      key: def.id,
      source: 'content',
      definition: def,
      enabled: !fileOnly,
    } as ScheduleRow,
    def,
    run: { id: 'r1', scheduleId: 's1', scheduleKey: def.id, trigger: 'manual' } as ScheduleRunRow,
    signal: new AbortController().signal,
    correlationId: 'corr-1',
    scheduledBy: null,
    fileOnly,
  };
}

/** Calls that belong to the transaction: its account lookups, the message it sends, the cleanup. */
const txCalls = (outbound: FakeOutbound) => outbound.calls.filter((c) => c.call.path.startsWith('/users/'));

describe('synthetic transactions in a run claimed after the schedule was turned off', () => {
  it('holds the transactions back and runs the other probes', async () => {
    const { jobs, outbound } = runner();
    const r = await jobs.run(ctxFor(true));
    expect(txCalls(outbound)).toEqual([]);
    expect(outbound.calls.some((c) => c.call.path === '/organization')).toBe(true);
    expect(r.result).toMatchObject({ probes: 2, held: ['probes.mail-flow'] });
    expect(r.result).not.toHaveProperty('transactions');
  });

  it('runs nothing when every probe is a transaction, and says why', async () => {
    const { jobs, outbound } = runner({ onlyTx: true });
    const r = await jobs.run(ctxFor(true));
    expect(outbound.calls).toEqual([]);
    expect(r).toMatchObject({ status: 'failed', error: { code: 'schedule_disabled' } });
  });

  it('runs the transactions when the schedule is on (control)', async () => {
    const { jobs, outbound } = runner();
    await jobs.run(ctxFor(false));
    expect(outbound.calls.some((c) => c.call.path === `/users/${ACCOUNT}/sendMail`)).toBe(true);
  });
});
