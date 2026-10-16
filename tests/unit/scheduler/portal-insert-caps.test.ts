import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import type { NewSchedule } from '@adminforge/api/src/schedules/types';
import { Schedule } from '@adminforge/schemas';

// Portal schedule caps are counted and the row inserted in one step: simultaneous requests can't pass a cap.

const NOW = new Date('2026-10-15T12:00:00Z');
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

function portalRow(key: string, createdBy: string, status?: 'retired'): NewSchedule & { createdBy: string } {
  return {
    key,
    source: 'portal',
    definition: Schedule.parse({
      kind: 'schedule',
      id: key,
      version: '1.0.0',
      title: 'Seed',
      owner: 'seed@example.com',
      cron: '0 6 * * 1',
      job: { kind: 'report', ref: 'identity.x', delivery: [{ type: 'file', format: 'xlsx' }] },
      ...(status ? { status } : {}),
    }),
    sha256: `sha-${key}`,
    enabled: false,
    nextRunAt: null,
    createdBy,
  };
}

const caps = { total: 5, perCreator: 3, recent: 4, since: new Date(NOW.getTime() - 86_400_000) };

describe('MemoryScheduleStore.insertPortalSchedule', () => {
  it('lets exactly perCreator of many simultaneous requests through', async () => {
    const store = new MemoryScheduleStore(() => NOW);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.insertPortalSchedule(portalRow(`portal.a-${i}`, A), caps)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.reason))).toEqual(
      Array(7).fill('perCreator'),
    );
  });

  it('counts deleted rows for the recent cap, not for the active caps; total across creators; duplicate keys', async () => {
    const store = new MemoryScheduleStore(() => NOW);
    await store.insertSchedule(portalRow('portal.a-old-1', A, 'retired'));
    await store.insertSchedule(portalRow('portal.a-old-2', A, 'retired'));
    await store.insertSchedule(portalRow('portal.a-old-3', A, 'retired'));
    expect((await store.insertPortalSchedule(portalRow('portal.a-1', A), caps)).ok).toBe(true);
    expect(await store.insertPortalSchedule(portalRow('portal.a-2', A), caps)).toEqual({
      ok: false,
      reason: 'recent',
    });
    for (let i = 0; i < 3; i++) await store.insertPortalSchedule(portalRow(`portal.b-${i}`, B), caps);
    const total = await store.insertPortalSchedule(
      portalRow('portal.c-1', '00000000-0000-4000-8000-0000000000c3'),
      {
        ...caps,
        total: 4,
      },
    );
    expect(total).toEqual({ ok: false, reason: 'total' });
    expect(await store.insertPortalSchedule(portalRow('portal.a-1', B), { ...caps, perCreator: 9 })).toEqual({
      ok: false,
      reason: 'exists',
    });
  });
});
