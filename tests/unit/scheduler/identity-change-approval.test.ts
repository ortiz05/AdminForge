import { planSync } from '@adminforge/api/src/schedules/sync';
import type { ScheduleRow } from '@adminforge/api/src/schedules/types';
import { Schedule } from '@adminforge/schemas';
import { sha } from './helpers';

// Two-person approval covers exactly the definition it was given for (its sha256). Changing who a write schedule
// runs as (ADR-014) changes the definition, so the approval goes and the schedule stops until a second person
// approves the new identity — an approved schedule can't be moved to a more powerful app identity quietly.

const NOW = new Date('2026-10-15T12:00:00Z');
const base = {
  kind: 'schedule',
  id: 'ops.disable-stale',
  version: '1.0.0',
  title: 'Disable stale accounts',
  owner: 'identity-team',
  cron: '0 3 * * *',
  job: { kind: 'playbook', ref: 'identity.disable-stale', mode: 'write', approvedBy: ['change CHG-1'] },
};

function row(def: Schedule): ScheduleRow {
  return {
    id: 'id-1',
    key: def.id,
    source: 'content',
    definition: def,
    sha256: sha(JSON.stringify(def)),
    enabled: true,
    createdBy: null,
    runAs: null,
    runAsSetBy: null,
    runAsSetAt: null,
    approvedIdentity: 'automation',
    approvedBy: 'blake@example.com',
    approvedTarget: 'fingerprint-1',
    nextRunAt: NOW,
    lastRunAt: null,
    lastStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('changing a write schedule’s identity', () => {
  it('voids its approval and turns it off', () => {
    const approved = Schedule.parse(base);
    const moved = Schedule.parse({ ...base, version: '1.1.0', identity: { app: 'identity-ops' } });
    const plan = planSync(
      [{ key: moved.id, def: moved, sha256: sha(JSON.stringify(moved)) }],
      [row(approved)],
      NOW,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.patch).toMatchObject({
      enabled: false,
      approvedBy: null,
      approvedTarget: null,
      approvedIdentity: null,
      definition: { identity: { app: 'identity-ops' } },
    });
  });

  it('the definition fingerprint differs between identities (the sha256 the approval binds)', () => {
    const a = Schedule.parse(base);
    const b = Schedule.parse({ ...base, identity: { app: 'identity-ops' } });
    expect(sha(JSON.stringify(a))).not.toBe(sha(JSON.stringify(b)));
  });
});
