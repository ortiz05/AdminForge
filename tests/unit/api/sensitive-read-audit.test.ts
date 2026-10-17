import { sensitiveReadAudit } from '@adminforge/api/src/datasources/services';
import type { SensitiveRead } from '@adminforge/api/src/execution/outbound';

// A secret-bearing read (App Service app settings: names only) is audited with who did it. For unattended reads
// (ADR-014) the event also says which identity read it and for which schedule.

const PATH =
  '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Web/sites/app/config/appsettings/list';
const read = (identity: SensitiveRead['identity']): SensitiveRead => ({
  identity,
  service: 'arm',
  method: 'POST',
  path: PATH,
  correlationId: 'c-1',
  result: 'success',
  names: 3,
});

describe('sensitive-read audit events', () => {
  it('a named app identity, for a schedule', () => {
    expect(
      sensitiveReadAudit(
        read({ kind: 'automation', mode: 'read', app: 'reports-team', schedule: 'reports.x' }),
      ),
    ).toMatchObject({
      actorUpn: 'app identity reports-team',
      action: 'outbound.sensitive_read',
      details: { executedAs: 'the app identity reports-team', schedule: 'reports.x', valuesReturned: false },
    });
  });

  it('a creator’s grant: the creator as actor, their access and the schedule named', () => {
    const e = sensitiveReadAudit(
      read({
        kind: 'grant',
        mode: 'read',
        grant: {
          scheduleId: 's-1',
          scheduleKey: 'portal.x-c0ffee',
          oid: 'u-1',
          upn: 'avery@example.com',
          homeAccountId: 'h',
          partitionKey: 'schedule:s-1',
        },
      }),
    );
    expect(e).toMatchObject({
      actorOid: 'u-1',
      actorUpn: 'avery@example.com',
      details: { executedAs: "avery@example.com's own access", schedule: 'portal.x-c0ffee' },
    });
  });

  it('the automation identity without a schedule (a probe sweep run by hand): no schedule key', () => {
    const e = sensitiveReadAudit(read({ kind: 'automation', mode: 'read' }));
    expect(e.details).toMatchObject({ executedAs: 'the automation identity' });
    expect(e.details).not.toHaveProperty('schedule');
  });
});
