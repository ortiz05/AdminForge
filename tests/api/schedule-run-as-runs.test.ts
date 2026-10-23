import { ScheduleIdentities, MemoryScheduleGrantStore } from '@adminforge/api/src/schedules/grants';
import { ScheduleService } from '@adminforge/api/src/schedules/service';
import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import { FakeDefinitions, schedule } from '../support/scheduler';

// A run uses the account a schedule runs as now (its override, else its definition, else the default), and an Operator
// can only point a schedule at an identity that already holds the application permissions it declares.
const now = () => new Date('2026-10-23T12:00:00Z');
const session = {
  userOid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
  roles: ['Portal.Reader', 'Portal.Operator'],
  idHash: 'session-hash',
} as never;
const caller = { session, correlationId: 'corr-1', ip: null };

async function storeWith(
  def = schedule('probes.sweep', { requires: { scopes: { graph: ['Sites.Read.All'] } } }),
) {
  const store = new MemoryScheduleStore(now);
  const row = (await store.insertSchedule({
    key: def.id,
    source: 'content',
    definition: def,
    sha256: 'sha-1',
    enabled: false,
    nextRunAt: null,
  }))!;
  return { store, row };
}

describe('the account a run uses', () => {
  const identities = (defaults = {}) =>
    new ScheduleIdentities({
      grants: new MemoryScheduleGrantStore(),
      auth: null,
      tokenCache: { delete: async () => undefined } as never,
      now,
      defaults,
    });

  it('is the default for its kind, then an Operator override', async () => {
    const { row } = await storeWith();
    const byDefault = await identities({ probes: 'reports-team' }).prepare(row, []);
    expect(byDefault).toMatchObject({
      identity: { app: 'reports-team' },
      executedAs: 'app identity reports-team',
    });
    const overridden = await identities({ probes: 'reports-team' }).prepare(
      { ...row, runAs: 'app:ops-team' },
      [],
    );
    expect(overridden).toMatchObject({ identity: { app: 'ops-team' } });
    const automation = await identities({ probes: 'reports-team' }).prepare(
      { ...row, runAs: 'automation' },
      [],
    );
    expect(automation.identity).not.toHaveProperty('app');
  });
});

describe('choosing an identity that lacks permissions', () => {
  const def = schedule('probes.sweep', { requires: { scopes: { graph: ['Sites.Read.All'] } } });
  function service(store: MemoryScheduleStore, missing: string[] | null) {
    const audit = { rows: [] as unknown[], append: async (r: unknown) => void audit.rows.push(r) };
    const asked: unknown[] = [];
    const svc = new ScheduleService({
      store,
      definitions: new FakeDefinitions().set(def) as never,
      audit: audit as never,
      events: { publish: () => undefined } as never,
      artifacts: {} as never,
      now,
      apps: () => ['ops-team'],
      permissionsMissing: async (identity, scopes) => {
        asked.push({ identity, scopes });
        return missing;
      },
    });
    return { svc, audit, asked };
  }

  it('is refused with the permissions it lacks and the way to grant them', async () => {
    const store = new MemoryScheduleStore(now);
    const { svc, audit, asked } = service(store, ['Sites.Read.All (graph)']);
    const err = await svc.setRunAs(caller, 'probes.sweep', 'app:ops-team').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'identity_lacks_permissions' });
    expect(String((err as Error).message)).toContain('Sites.Read.All (graph)');
    expect(asked).toEqual([{ identity: { app: 'ops-team' }, scopes: { graph: ['Sites.Read.All'] } }]);
    expect((await store.getSchedule('probes.sweep'))!.runAs).toBeNull();
    expect(audit.rows).toEqual([]);
  });

  it('is allowed when the permissions are there, or when they can’t be checked here', async () => {
    for (const missing of [[], null]) {
      const store = new MemoryScheduleStore(now);
      const { svc } = service(store, missing);
      expect(await svc.setRunAs(caller, 'probes.sweep', 'app:ops-team')).toEqual({ disabled: false });
      expect((await store.getSchedule('probes.sweep'))!).toMatchObject({
        runAs: 'app:ops-team',
        runAsSetBy: 'avery@example.com',
      });
    }
  });
});
