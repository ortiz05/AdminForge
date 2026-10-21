import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import pg from 'pg';
import { loadEnv, repoRoot } from '@adminforge/config';
import { chainHash, GENESIS } from '@adminforge/api/src/audit/chain';
import { importPostgres } from '@adminforge/cli/src/commands/db';

// `adminforge db import-postgres`: the one-time move from the Postgres releases (ADR-016). A throwaway Postgres
// database gets the last release's schema (tests/fixtures/postgres) and synthetic rows of every kind; the import must
// copy them faithfully into a new SQLite file — the audit chain still verifying, decided approvals intact, key order
// kept, credentials left behind. Needs a Postgres to create that database in: TEST_POSTGRES_URL, or the DATABASE_URL
// an older dev env file still has; the suite skips without one.
const SCHEMA = readFileSync(
  path.join(repoRoot, 'tests', 'fixtures', 'postgres', 'last-release-schema.sql'),
  'utf8',
);

async function serverUrl(): Promise<string | null> {
  const base = process.env.TEST_POSTGRES_URL ?? loadEnv().DATABASE_URL;
  if (!base?.startsWith('postgres')) return null;
  const c = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3_000 });
  c.on('error', () => undefined);
  try {
    await c.connect();
    await c.query('select 1');
    return base;
  } catch {
    return null;
  } finally {
    await c.end().catch(() => undefined);
  }
}

const server = await serverUrl();
const T0 = Date.parse('2026-10-15T08:00:00.000Z');
const RUN1 = '00000000-0000-4000-8000-000000000001';

describe.skipIf(!server)('db import-postgres', () => {
  let admin: pg.Client;
  let source: string;
  let name: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: server! });
    await admin.connect();
    name = `adminforge_import_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await admin.query(`create database ${name}`);
    const url = new URL(server!);
    url.pathname = `/${name}`;
    source = url.toString();
    const c = new pg.Client({ connectionString: source });
    await c.connect();
    try {
      await c.query(SCHEMA);
      await seed(c);
    } finally {
      await c.end();
    }
  });
  afterAll(async () => {
    await admin.query(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await admin.end();
  });

  const target = () => path.join(mkdtempSync(path.join(tmpdir(), 'af-import-')), 'adminforge.db');

  it('copies every table, keeps the audit chain verifying and leaves credentials behind', async () => {
    const file = target();
    const lines: string[] = [];
    // Pages of 5: the audit log's keyset paging crosses seq 9 → 10 (numeric order, not text order).
    const report = await importPostgres({ DATABASE_URL: source, DATABASE_PATH: file }, (l) => lines.push(l), {
      now: () => T0 + 86_400_000,
      pageSize: 5,
    });
    expect(report!.audit).toMatchObject({ count: 12, tail: { seq: 12 } });
    expect(report!.audit.tail).toEqual(report!.audit.postgresTail);
    expect(Object.fromEntries(report!.tables.map((t) => [t.table, t.sqlite]))).toMatchObject({
      settings: 1,
      definitions: 1,
      runs: 2,
      run_steps: 1,
      run_step_events: 1,
      approvals: 1,
      schedules: 1,
      schedule_runs: 1,
      probe_results: 1,
      news_items: 1,
      token_cache: 1,
      audit_events: 12,
    });
    expect(report!.queuedRuns).toBe(1);
    expect(lines[0]).toMatch(/^✓ Imported into /);
    expect(lines.join('\n')).toMatch(/Not imported: signed-in sessions/);

    const db = new BetterSqlite3(file, { readonly: true });
    try {
      const one = <T>(sql: string) => db.prepare(sql).get() as T;
      // Credentials: no sessions, no session tokens; a schedule's sealed grant token stays (same TOKEN_CACHE_KEY).
      expect(one('select count(*) as n from sessions')).toEqual({ n: 0 });
      expect(db.prepare('select partition_key from token_cache').all()).toEqual([
        { partition_key: 'schedule:s-1' },
      ]);
      // Shapes: ms instants, JSON text with the authored key order, JSON arrays, 0/1 booleans, text ids.
      const def = one<{ body: string; created_at: number }>('select body, created_at from definitions');
      expect(def.body.replace(/\s/g, '')).toBe(
        '{"kind":"page","id":"identity.users","version":"1.2.0","title":"Users"}',
      );
      expect(def.created_at).toBe(T0);
      expect(JSON.parse(one<{ areas: string }>('select areas from news_items').areas)).toEqual([
        'identity',
        'exchange',
      ]);
      expect(one('select enabled from schedules')).toEqual({ enabled: 1 });
      expect(one(`select dry_run, created_at from runs where id = '${RUN1}'`)).toEqual({
        dry_run: 0,
        created_at: T0 + 1_000,
      });
      const approval = one<{ status: string; decisions: string }>('select status, decisions from approvals');
      expect(approval.status).toBe('approved');
      expect(JSON.parse(approval.decisions)).toEqual([
        { oid: 'u-2', decision: 'approve', at: '2026-10-15T09:00:00.000Z' },
      ]);
      // The open root run had a pg-boss job, which is not copied: it is queued again (the finished child is not).
      expect(db.prepare('select run_id, state, start_after from run_jobs').all()).toEqual([
        { run_id: RUN1, state: 'queued', start_after: T0 + 86_400_000 },
      ]);
      expect(one<{ value: string }>("select value from settings where key = 'appearance'").value).toBe(
        '{"accent": "steel"}',
      );
    } finally {
      db.close();
    }
    // The append-only trigger the import lifted is back.
    const rw = new BetterSqlite3(file);
    try {
      expect(() =>
        rw
          .prepare(
            `insert into approvals (id, subject_type, subject_id, policy, status, requested_by, created_at)
             values ('x', 'run', 'y', '{}', 'approved', 'u', 1)`,
          )
          .run(),
      ).toThrow('approvals: a new approval starts pending, with no decisions');
    } finally {
      rw.close();
    }
  });

  it('a dry run shows the counts and writes nothing; a used target is refused', async () => {
    const file = target();
    const lines: string[] = [];
    expect(
      await importPostgres({ DATABASE_URL: source, DATABASE_PATH: file }, (l) => lines.push(l), {
        dryRun: true,
      }),
    ).toBeNull();
    expect(lines[0]).toBe(`Would import into ${file}:`);
    expect(lines.some((l) => /audit_events\s+12 row\(s\)/.test(l))).toBe(true);
    await importPostgres({ DATABASE_URL: source }, () => undefined, { to: file });
    await expect(importPostgres({ DATABASE_URL: source }, () => undefined, { to: file })).rejects.toThrow(
      /already holds data \(settings\): import into a new file/,
    );
  });

  it('needs the Postgres URL in the environment, never on the command line', async () => {
    await expect(importPostgres({ DATABASE_PATH: target() }, () => undefined)).rejects.toThrow(
      'DATABASE_URL is not set: it must hold the URL of the Postgres database to import.',
    );
    await expect(
      importPostgres({ OLD_DB: source, DATABASE_PATH: target() }, () => undefined, {
        fromEnv: 'OLD_DB',
        dryRun: true,
      }),
    ).resolves.toBeNull();
  });
});

/** Synthetic rows of every kind, written the way the Postgres releases wrote them. */
async function seed(c: pg.Client) {
  const at = (ms: number) => new Date(T0 + ms);
  const run1 = RUN1;
  // The child's id sorts before its parent's: the import (in id order) copies it first, so foreign keys are only
  // checked at the commit.
  const run2 = '00000000-0000-4000-8000-000000000000';
  const sched = '00000000-0000-4000-8000-0000000000a1';
  await c.query(
    `insert into settings (key, value, updated_at) values ('appearance', '{"accent":"steel"}', $1)`,
    [at(0)],
  );
  await c.query(
    `insert into user_prefs (user_oid, prefs, updated_at) values ('u-1', '{"theme":"daylight"}', $1)`,
    [at(0)],
  );
  await c.query(
    `insert into definitions (kind, key, version, status, source, body, sha256, created_at, published_at)
     values ('page', 'identity.users', '1.2.0', 'published', 'git', $1::json, 'sha', $2, $2)`,
    ['{"kind":"page","id":"identity.users","version":"1.2.0","title":"Users"}', at(0)],
  );
  await c.query(
    `insert into schedules (id, key, source, definition, sha256, enabled, created_at, updated_at)
     values ($1, 'reports.daily', 'content', '{"id":"reports.daily"}', 'sha', true, $2, $2)`,
    [sched, at(0)],
  );
  await c.query(
    `insert into schedule_grants (schedule_id, user_oid, upn, home_account_id, status, consented_at)
     values ($1, 'u-1', 'avery@example.com', 'home', 'active', $2)`,
    [sched, at(0)],
  );
  for (const [id, parent, status] of [
    [run1, null, 'running'],
    [run2, run1, 'succeeded'],
  ] as const)
    await c.query(
      `insert into runs (id, kind, definition_key, definition_version, definition_sha256, status, dry_run, trigger,
         identity, parent_run_id, schedule_id, inputs, correlation_id, created_at, updated_at)
       values ($1, 'playbook', 'identity.disable-user', '1.0.0', 'sha', $2, false, 'interactive', 'delegated', $3, $4,
         '{"user":"x"}', 'c', $5, $5)`,
      [id, status, parent, parent ? null : sched, at(1_000)],
    );
  await c.query(
    `insert into run_steps (run_id, seq, step_id, path, type, status, mode, output, started_at)
     values ($1, 1, 'disable', 'disable', 'graph', 'succeeded', 'write', '{"ok":true}', $2)`,
    [run1, at(2_000)],
  );
  await c.query(`insert into run_step_events (run_id, type, data, ts) values ($1, 'status', '{}', $2)`, [
    run1,
    at(2_000),
  ]);
  // A decided approval: the Postgres trigger let it become approved by an update, as the service does.
  const approval = randomUUID();
  await c.query(
    `insert into approvals (id, subject_type, subject_id, step_id, policy, requested_by, created_at)
     values ($1, 'run', $2, 'approve', '{"kind":"approval"}', 'u-1', $3)`,
    [approval, run1, at(3_000)],
  );
  await c.query(`update approvals set decisions = $2, status = 'approved', decided_at = $3 where id = $1`, [
    approval,
    JSON.stringify([{ oid: 'u-2', decision: 'approve', at: '2026-10-15T09:00:00.000Z' }]),
    at(4_000),
  ]);
  const scheduleRun = randomUUID();
  await c.query(
    `insert into schedule_runs (id, schedule_id, schedule_key, trigger, status, started_at)
     values ($1, $2, 'reports.daily', 'cron', 'succeeded', $3)`,
    [scheduleRun, sched, at(5_000)],
  );
  await c.query(
    `insert into probe_results (probe_key, ts, status, metric, schedule_run_id) values ('probes.graph', $1, 'ok', 12.5, $2)`,
    [at(5_000), scheduleRun],
  );
  await c.query(
    `insert into news_items (feed_key, external_id, title, url, kind, severity, areas, audience, published_at,
       activity_at, content_hash) values ('m365.message-center', 'MC1', 'A change', 'https://example.com/mc1',
       'change', 'normal', $1, $2, $3, $3, 'h')`,
    [['identity', 'exchange'], ['Portal.Reader'], at(0)],
  );
  await c.query(
    `insert into news_feed_state (feed_key, status, items) values ('m365.message-center', 'ok', 1)`,
  );
  await c.query(
    `insert into sessions (id_hash, user_oid, upn, display_name, tenant_id, tenant_name, tenant_domain, csrf, expires_at)
     values ('sid', 'u-1', 'avery@example.com', 'Avery', 't', 'Example Org', 'example.com', 'c', $1)`,
    [at(86_400_000)],
  );
  await c.query(
    `insert into token_cache (partition_key, sealed) values ('read:sid', 'sealed'), ('schedule:s-1', 'sealed')`,
  );
  // The audit chain, hashed exactly as the API wrote it (jsonb reorders the details' keys; the hash is canonical).
  let prev = GENESIS;
  for (let i = 1; i <= 12; i++) {
    const event = {
      ts: at(i * 10_000).toISOString(),
      actorOid: 'u-1',
      actorUpn: 'avery@example.com',
      sessionHash: null,
      mode: 'read',
      action: 'test.event',
      targetType: null,
      targetId: null,
      details: { zeta: i, alpha: 'a' },
      result: 'success',
      correlationId: `c-${i}`,
      ip: null,
    };
    const hash = chainHash(prev, event);
    await c.query(
      `insert into audit_events (seq, ts, actor_oid, actor_upn, mode, action, details, result, correlation_id, prev_hash, hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        i,
        event.ts,
        event.actorOid,
        event.actorUpn,
        event.mode,
        event.action,
        event.details,
        event.result,
        event.correlationId,
        prev,
        hash,
      ],
    );
    prev = hash;
  }
}
