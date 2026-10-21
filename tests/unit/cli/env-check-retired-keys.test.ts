import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envCheck } from '@adminforge/cli/src/commands/env';
import { RETIRED_KEYS } from '@adminforge/cli/src/env/env-check';

// An env file from the Postgres releases still names DATABASE_URL, the pool limits, the owner credentials and the
// in-process switches. `adminforge env check` says once that nothing reads them any more (ADR-016) — not "typo?" —
// and never prints their values.
describe('adminforge env check with keys of the Postgres releases', () => {
  it('names the retired keys, says what replaced them, and prints no value', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-env-'));
    try {
      const file = path.join(dir, 'unit.env');
      writeFileSync(
        file,
        [
          'DATABASE_URL=postgres://adminforge_dev:pw-must-not-print@127.0.0.1:55432/adminforge_dev',
          'POSTGRES_PASSWORD=pw-must-not-print',
          'SCHEDULER_IN_PROCESS=true',
          'DATABASE_PATH=/srv/af/dev.db',
          'NOT_A_REAL_KEY=x',
        ].join('\n'),
      );
      const lines: string[] = [];
      envCheck((l) => lines.push(l), { env: { ADMINFORGE_ENV_FILE: file } });
      const text = lines.join('\n');
      expect(text).toContain(
        'unit.env still sets DATABASE_URL, POSTGRES_PASSWORD, SCHEDULER_IN_PROCESS: AdminForge no longer uses them (the database is the SQLite file in DATABASE_PATH, and the API runs the worker and the scheduler). Remove them.',
      );
      expect(text).toContain('Not in config/example.env (typo?): NOT_A_REAL_KEY');
      expect(text).not.toContain('pw-must-not-print');
      expect(text).not.toContain('/srv/af/dev.db');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers every key the Postgres releases documented', () => {
    expect([...RETIRED_KEYS].sort()).toEqual([
      'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      'DATABASE_LOCK_TIMEOUT_MS',
      'DATABASE_MIGRATION_URL',
      'DATABASE_POOL_MAX',
      'DATABASE_STATEMENT_TIMEOUT_MS',
      'DATABASE_URL',
      'POSTGRES_PASSWORD',
      'RUN_WORKER_IN_PROCESS',
      'SCHEDULER_IN_PROCESS',
    ]);
  });
});
