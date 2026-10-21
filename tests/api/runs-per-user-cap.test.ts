import { mockConfig } from './helpers';
import { runsApp } from './runs-helpers';
import { capCases, capDefinitions } from './runs-per-user-cap-cases';

// F-08 on the in-memory repository (mock mode). The cases: runs-per-user-cap-cases.ts.
describe('at most 5 open runs per person (F-08), in memory', () => {
  capCases(async (env = {}) => {
    const t = await runsApp({
      config: mockConfig(env),
      definitions: capDefinitions(),
      runs: { inProcessWorker: false },
    });
    return { app: t.app, repository: t.repository, login: t.login, close: t.close };
  });
});
