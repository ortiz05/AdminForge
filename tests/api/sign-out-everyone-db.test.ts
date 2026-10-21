import { buildApp } from '@adminforge/api/src/app';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { dbSignOutEveryone } from '@adminforge/cli/src/commands/db';
import { ConfigError } from '@adminforge/cli/src/shared/errors';
import { testDatabasePath } from './db';
import { cookieFrom, getMe, mockConfig } from './helpers';

// The emergency step "end every session" (docs/operations.md → Emergency): `adminforge db sign-out-everyone`, run in
// the pod beside the API, deletes every session, pending sign-in and session token — and the running API, which reads
// sessions from the database on each request, signs everyone out at their next request. Audited; needs --yes.
describe('adminforge db sign-out-everyone (SQLite)', () => {
  let file: string;
  let database: Database;
  const count = (table: string) =>
    (database.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

  beforeEach(async () => {
    file = await testDatabasePath();
    database = createDatabase(file);
  });
  afterEach(async () => {
    await database.close();
  });

  it('signs out a live session of the running app, keeps schedule grants unless asked, and is audited', async () => {
    const app = await buildApp(mockConfig({ DATABASE_PATH: file }));
    try {
      const cookie = cookieFrom(await app.inject({ method: 'GET', url: '/auth/login' }))!;
      expect((await getMe(app, cookie)).me?.user.name).toBe('Avery Engineer');
      database.sqlite
        .prepare(
          `insert into token_cache (partition_key, sealed, updated_at)
           values ('read:x', 's', 1), ('schedule:s-1', 's', 1)`,
        )
        .run();
      const lines: string[] = [];
      const result = await dbSignOutEveryone({ DATABASE_PATH: file }, (l) => lines.push(l), { yes: true });
      expect(result).toMatchObject({ sessions: 1, tokens: 1 });
      expect(lines[0]).toMatch(/^✓ Signed out everyone: 1 session\(s\)/);
      expect(count('sessions')).toBe(0);
      expect(database.sqlite.prepare('select partition_key from token_cache').all()).toEqual([
        { partition_key: 'schedule:s-1' },
      ]);
      // The same cookie no longer works on the running app.
      expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
      const audit = database.sqlite
        .prepare("select actor_oid, details from audit_events where action = 'sessions.signed_out_everyone'")
        .get() as { actor_oid: string; details: string };
      expect(audit.actor_oid).toBe('cli');
      expect(JSON.parse(audit.details)).toMatchObject({ sessions: 1, tokens: 1, scheduleGrants: false });
      // --schedule-grants voids schedules' stored access too.
      await dbSignOutEveryone({ DATABASE_PATH: file }, () => undefined, { yes: true, scheduleGrants: true });
      expect(count('token_cache')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('does nothing without --yes, and needs an existing database', async () => {
    await expect(dbSignOutEveryone({ DATABASE_PATH: file }, () => undefined)).rejects.toThrow(
      'This signs out everyone at once. Run it again with --yes.',
    );
    await expect(
      dbSignOutEveryone({ DATABASE_PATH: `${file}.missing` }, () => undefined, { yes: true }),
    ).rejects.toThrow(ConfigError);
  });
});
