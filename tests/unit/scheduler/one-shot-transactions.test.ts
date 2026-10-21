import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditInput } from '@adminforge/api/src/audit/writer';
import { loadConfig } from '@adminforge/api/src/config';
import { PAUSE_KEYS } from '@adminforge/api/src/execution/emergency';
import type { ProbeOutcome } from '@adminforge/api/src/probes/checks';
import { openOneShot, runProbesOnce, type ProbesOnceDeps } from '@adminforge/scheduler/one-shot';
import { testDatabasePath } from '../../api/db';
import { FakeDefinitions, probe } from './helpers';

// L1 (whole-branch security review): synthetic transactions (ADR-015) are the scheduler one-shots' only writes, and
// `--probe` / `--once` ran them with no audit record; with `--no-store` (no database) the emergency stop couldn't be
// read either, so "changes paused" never applied, and "automation paused" was never checked. Now a transaction that
// acted is audited as a write, none runs while automation is paused, and without the database every declared write is
// refused.

const NOW = new Date('2026-10-21T12:00:00Z');
const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const MAIL = { kind: 'mailFlow', from: '${ env.AF_MAIL_SENDER }', to: '${ env.AF_SYNTHETIC_MAILBOX }' };

function outcome(key: string, over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    probeKey: key,
    ts: NOW,
    status: 'ok',
    metric: 4,
    unit: 's',
    durationMs: 4000,
    message: 'Delivered to the test mailbox',
    code: 'ok',
    details: null,
    ...over,
  };
}

function setup(over: Partial<ProbesOnceDeps> = {}, code = 'ok') {
  const defs = new FakeDefinitions()
    .set(probe('probes.mail', { check: MAIL, timeoutMs: 110_000 }))
    .set(probe('probes.reach'));
  const ran: Array<{ key: string; correlationId?: string }> = [];
  const audited: AuditInput[] = [];
  const warnings: string[] = [];
  const deps: ProbesOnceDeps = {
    definitions: defs,
    probeDeps: {} as ProbesOnceDeps['probeDeps'],
    store: null,
    log: { warn: (_obj, msg) => warnings.push(msg) },
    run: async (key, _probe, _deps, opts) => {
      ran.push({ key, ...(opts?.correlationId ? { correlationId: opts.correlationId } : {}) });
      return outcome(key, key === 'probes.mail' ? { code, status: code === 'ok' ? 'ok' : 'error' } : {});
    },
    audit: {
      append: async (e) => {
        audited.push(e);
      },
    },
    automationPaused: async () => false,
    requestedBy: 'cli:operator',
    ...over,
  };
  return { deps, ran, audited, warnings };
}

describe('runProbesOnce: synthetic transactions', () => {
  it('audits one that acted as a write by the automation identity, under the correlation id it ran with', async () => {
    const { deps, ran, audited } = setup();
    await runProbesOnce(deps);
    expect(ran.map((r) => r.key)).toEqual(['probes.mail', 'probes.reach']);
    expect(audited).toEqual([
      {
        actorOid: 'automation',
        actorUpn: 'automation identity',
        mode: 'write',
        action: 'probe.run',
        targetType: 'probe',
        targetId: 'probes.mail',
        result: 'success',
        correlationId: ran[0]!.correlationId,
        details: {
          summary: 'Run once by cli:operator, executed as automation identity.',
          trigger: 'one-shot',
          requestedBy: 'cli:operator',
          check: 'mailFlow',
          status: 'ok',
          code: 'ok',
        },
      },
    ]);
  });

  it('a failed transaction that reached the tenant is audited as a failure; one that made no call is not audited', async () => {
    const failed = setup({}, 'not_delivered');
    await runProbesOnce(failed.deps);
    expect(failed.audited).toEqual([
      expect.objectContaining({ targetId: 'probes.mail', result: 'failure', mode: 'write' }),
    ]);
    for (const code of ['not_configured', 'writes_paused', 'licence_required', 'database_required']) {
      const quiet = setup({}, code);
      await runProbesOnce(quiet.deps);
      expect(quiet.audited).toEqual([]);
    }
  });

  it('none runs while automation is paused (the other probes still do)', async () => {
    const { deps, ran, audited } = setup({ automationPaused: async () => true });
    const r = await runProbesOnce(deps);
    expect(ran.map((x) => x.key)).toEqual(['probes.reach']);
    expect(r.results.find((x) => x.key === 'probes.mail')?.outcome).toMatchObject({
      status: 'error',
      code: 'automation_paused',
      metric: null,
      unit: 's',
    });
    expect(audited).toEqual([]);
  });

  it('an audit record that cannot be written is logged and the run goes on', async () => {
    const { deps, warnings } = setup({
      audit: {
        append: async () => {
          throw new Error('database is locked');
        },
      },
    });
    expect((await runProbesOnce(deps)).results).toHaveLength(2);
    expect(warnings).toEqual(['could not audit the synthetic transaction']);
  });
});

describe('openOneShot', () => {
  let dir: string;
  const config = (extra: Record<string, string> = {}) =>
    loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      AUTH_MODE: 'mock',
      DATA_MODE: 'fixtures',
      ADMINFORGE_FIXTURES_DIR: FIXTURES,
      CONTENT_DIR: path.join(dir, 'content'),
      CONTENT_WATCH: 'false',
      ADMINFORGE_ARTIFACTS_DIR: path.join(dir, 'artifacts'),
      ...extra,
    });
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'af-one-shot-tx-'));
    const write = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, 'content', rel)), { recursive: true });
      writeFileSync(path.join(dir, 'content', rel), text);
    };
    write(
      'probes/mail.probe.yaml',
      'kind: probe\nid: probes.mail\nversion: 1.0.0\ntitle: Mail flow\nowner: test-team\ncheck:\n  kind: mailFlow\n  from: ${ env.AF_MAIL_SENDER }\n  to: ${ env.AF_SYNTHETIC_MAILBOX }\ntimeoutMs: 110000\n',
    );
    write(
      'schedules/sweep.schedule.yaml',
      'kind: schedule\nid: schedules.sweep\nversion: 1.0.0\ntitle: Sweep\nowner: test-team\ncron: "0 * * * *"\nenabled: false\njob:\n  kind: probe\n  ref: probes.mail\n',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('without the database refuses every declared write its probes and jobs would send; reads go through', async () => {
    const oneShot = openOneShot(config(), { log: silent, noStore: true });
    try {
      const outbound = oneShot.schedules.probeDeps.outbound;
      await expect(
        outbound.execute(
          { kind: 'automation', mode: 'write' },
          { service: 'graph', method: 'POST', path: '/users/u/sendMail', body: {}, declaredWrite: true },
        ),
      ).rejects.toMatchObject({ code: 'database_required' });
      await expect(outbound.assertWritable!({ kind: 'automation', mode: 'write' }, [])).rejects.toMatchObject(
        {
          code: 'database_required',
        },
      );
      const read = await outbound.execute(
        { kind: 'automation', mode: 'read' },
        { service: 'graph', method: 'GET', path: '/organization' },
      );
      expect(read.status).toBe(200);
    } finally {
      await oneShot.close();
    }
  });

  it('with the database follows "automation paused": transactions and schedule runs are skipped', async () => {
    const file = await testDatabasePath();
    const oneShot = openOneShot(config({ DATABASE_PATH: file }), { log: silent });
    try {
      expect(oneShot.ctx.database).not.toBeNull();
      // With the database the probes use the executor itself (the emergency stop's "changes paused" applies there).
      expect(oneShot.schedules.probeDeps.outbound).toBe(oneShot.ctx.outbound);
      await oneShot.ctx.settings.put(
        PAUSE_KEYS.automation,
        { paused: true, reason: 'incident', by: 'admin@example.com', at: NOW.toISOString() },
        { updatedBy: 'admin@example.com', now: NOW },
      );
      const probes = await oneShot.runProbes(['probes.mail'], 'test:operator');
      expect(probes.results[0]?.outcome.code).toBe('automation_paused');
      const run = await oneShot.runSchedule('schedules.sweep', 'test:operator');
      expect(run).toMatchObject({ status: 'skipped', error: { code: 'automation_paused' } });
    } finally {
      await oneShot.close();
    }
  });
});
