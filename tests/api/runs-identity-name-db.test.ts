import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { SqliteRunRepository, type NewRun } from '@adminforge/api/src/runs';
import { testDatabasePath } from './db';

// ADR-014: a schedule that names an app identity runs as it, children included (runs/identity.ts reads
// `identityName`). On SQLite the name must survive the insert, or the run would execute as the automation identity.
const newRun = (over: Partial<NewRun> = {}): NewRun => ({
  id: randomUUID(),
  kind: 'playbook',
  definitionKey: 'test.named',
  definitionVersion: '1.0.0',
  definitionSha256: 'a'.repeat(64),
  dryRun: false,
  trigger: 'schedule',
  identity: 'automation',
  identityName: 'reports',
  initiatorOid: null,
  initiatorUpn: 'content (owner: tests)',
  sessionHash: null,
  scheduleId: null,
  parentRunId: null,
  inputs: {},
  correlationId: randomUUID(),
  ...over,
});

describe('runs on SQLite keep the app identity a run executes as', () => {
  let database: Database;
  beforeAll(async () => {
    database = createDatabase(await testDatabasePath());
  });
  afterAll(async () => {
    await database.close();
  });

  it('insertRun and insertRunIfAbsent store identityName', async () => {
    const repo = new SqliteRunRepository(database);
    const a = await repo.insertRun(newRun());
    expect(a.identityName).toBe('reports');
    expect((await repo.getRun(a.id))?.identityName).toBe('reports');
    const b = await repo.insertRunIfAbsent(
      newRun({ identityName: 'audit-reader', trigger: 'child', parentRunId: a.id }),
    );
    expect((await repo.getRun(b.id))?.identityName).toBe('audit-reader');
    const plain = await repo.insertRun(newRun({ identityName: null }));
    expect(plain.identityName).toBeNull();
  });
});
