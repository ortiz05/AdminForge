import { createDatabase } from '@adminforge/api/src/db/client';
import { SqliteRunQueue, SqliteRunRepository } from '@adminforge/api/src/runs';
import { testDatabasePath } from './db';
import { mockConfig } from './helpers';
import { runsApp } from './runs-helpers';
import { capCases, capDefinitions } from './runs-per-user-cap-cases';

// F-08 on SQLite: the count and the insert happen in one write transaction. The cases: runs-per-user-cap-cases.ts.
describe('at most 5 open runs per person (F-08), on SQLite', () => {
  capCases(async (env = {}) => {
    const file = await testDatabasePath();
    const database = createDatabase(file);
    const repository = new SqliteRunRepository(database);
    const t = await runsApp({
      config: mockConfig({ DATABASE_PATH: file, ...env }),
      definitions: capDefinitions(),
      database,
      repository,
      runs: { queue: new SqliteRunQueue(database), inProcessWorker: false },
    });
    return { app: t.app, repository, login: t.login, close: t.close };
  });
});
