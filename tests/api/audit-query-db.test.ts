import { queryAudit } from '@adminforge/api/src/admin/audit-query';
import { SqliteAuditWriter } from '@adminforge/api/src/audit/writer';
import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { testDatabasePath } from './db';

// The Audit page's filters on the database (the investigation path once the audit log is the tamper evidence,
// ADR-016): a person by part of their UPN, case-insensitive, and an action family by prefix — with `%`, `_` and `\`
// in what was typed matching themselves, not as wildcards.
describe('audit search (SQLite)', () => {
  let database: Database;
  let writer: SqliteAuditWriter;

  beforeAll(async () => {
    database = createDatabase(await testDatabasePath());
    writer = new SqliteAuditWriter(database.db, undefined, null);
    const event = (actorUpn: string, action: string) =>
      writer.append({
        actorOid: 'u',
        actorUpn,
        action,
        result: 'success',
        correlationId: `${actorUpn}-${action}`,
      });
    await event('Avery.Engineer@example.com', 'run.created');
    await event('avery.engineer@example.com', 'run.approved');
    await event('blake_ops@example.com', 'session.signin');
    await event('blakexops@example.com', 'session.signin');
    await event('casey%admin@example.com', 'runbook.started');
  });
  afterAll(async () => {
    await database.close();
  });

  const actions = async (q: Parameters<typeof queryAudit>[2]) =>
    (await queryAudit(database, writer, q)).items.map((i) => `${i.actorUpn} ${i.action}`);

  it('finds a person by part of their UPN, whatever the case', async () => {
    expect(await actions({ actor: 'AVERY.eng' })).toEqual([
      'avery.engineer@example.com run.approved',
      'Avery.Engineer@example.com run.created',
    ]);
  });

  it('treats % and _ in the search as themselves', async () => {
    expect(await actions({ actor: 'blake_ops' })).toEqual(['blake_ops@example.com session.signin']);
    expect(await actions({ actor: 'casey%' })).toEqual(['casey%admin@example.com runbook.started']);
    expect(await actions({ actor: '%' })).toEqual(['casey%admin@example.com runbook.started']);
  });

  it('filters an action family by prefix, and an exact action exactly', async () => {
    expect(await actions({ action: 'run.*' })).toEqual([
      'avery.engineer@example.com run.approved',
      'Avery.Engineer@example.com run.created',
    ]);
    expect(await actions({ action: 'run.' })).toHaveLength(2);
    expect(await actions({ action: 'session.signin', actor: 'blake' })).toHaveLength(2);
  });
});
