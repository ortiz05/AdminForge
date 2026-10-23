import { declaredScopes, runAsDefaultsFrom } from '@adminforge/cli/src/content/scopes';
import { probe, schedule } from '../../support/scheduler';

// What provisioning grants each identity follows the account each schedule runs as: the identity it names, else the
// installation default for its kind (read-only jobs), else the automation identity; a probe's permissions go to the
// account of each sweep that runs it.
const loaded = (def: unknown, file = 'x.yaml') => ({ def, file }) as never;
const sites = { graph: ['Sites.Read.All'] };

describe('declared permissions by run-as account', () => {
  it('credits a read-only schedule to the default for its kind, a write-capable one never', () => {
    const defs = [
      loaded(
        schedule('reports.weekly', {
          job: { kind: 'report', ref: 'r.x', delivery: [{ type: 'file' }] },
          requires: { scopes: sites },
        }),
      ),
      loaded(
        schedule('ops.fix', {
          job: { kind: 'playbook', ref: 'p.x', mode: 'write', approvedBy: ['approval-1'] },
          requires: { scopes: { graph: ['User.ReadWrite.All'] } },
        }),
      ),
    ];
    const { scopes } = declaredScopes(
      defs,
      runAsDefaultsFrom({ AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS: 'reports-team' }),
    );
    expect([...(scopes['identity:reports-team']?.graph ?? [])]).toEqual(['Sites.Read.All']);
    expect([...(scopes.automation?.graph ?? [])]).toEqual(['User.ReadWrite.All']);
  });

  it('credits a probe to the account of each sweep that runs it, else the automation identity', () => {
    const defs = [
      loaded(probe('probes.sites', { tags: ['sweep-15m'], requires: { scopes: sites } })),
      loaded(
        probe('probes.lonely', { tags: ['nobody'], requires: { scopes: { graph: ['Group.Read.All'] } } }),
      ),
      loaded(schedule('sweep.a', { job: { kind: 'probe', select: { tags: ['sweep-15m'] } } })),
      loaded(
        schedule('sweep.b', { job: { kind: 'probe', ref: 'probes.sites' }, identity: { app: 'ops-team' } }),
      ),
    ];
    const { scopes } = declaredScopes(
      defs,
      runAsDefaultsFrom({ AF_SCHEDULE_DEFAULT_IDENTITY_PROBES: 'reports-team' }),
    );
    expect([...(scopes['identity:reports-team']?.graph ?? [])]).toEqual(['Sites.Read.All']);
    expect([...(scopes['identity:ops-team']?.graph ?? [])]).toEqual(['Sites.Read.All']);
    expect([...(scopes.automation?.graph ?? [])]).toEqual(['Group.Read.All']);
  });

  it('reads the defaults from the env file, ignoring blanks', () => {
    expect(
      runAsDefaultsFrom({
        AF_SCHEDULE_DEFAULT_IDENTITY: ' ops-team ',
        AF_SCHEDULE_DEFAULT_IDENTITY_PROBES: '',
      }),
    ).toEqual({
      all: 'ops-team',
    });
  });
});
