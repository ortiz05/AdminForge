import { MemoryScheduleStore } from '@adminforge/api/src/schedules/store';
import {
  initiallyEnabled,
  planSync,
  syncSchedules,
  type ContentSchedule,
} from '@adminforge/api/src/schedules/sync';
import { schedule, sha } from './helpers';

const NOW = new Date('2026-10-15T12:07:00Z');
const c = (id: string, extra: Record<string, unknown> = {}): ContentSchedule => {
  const def = schedule(id, extra);
  return { key: id, def, sha256: sha(JSON.stringify(def)) };
};
const WRITE_JOB = {
  job: { kind: 'playbook', ref: 'identity.disable-user', mode: 'write', approvedBy: ['approval-1'] },
};

describe('content → schedules sync', () => {
  it('starts read-only schedules that say enabled: true, and nothing else', () => {
    expect(initiallyEnabled(c('a.read').def)).toBe(true);
    expect(initiallyEnabled(c('a.off', { enabled: false }).def)).toBe(false);
    expect(initiallyEnabled(c('a.write', WRITE_JOB).def)).toBe(false);
    expect(initiallyEnabled(c('a.draft', { status: 'draft' }).def)).toBe(false);
  });

  it('inserts new schedules with their next run (enabled ones only)', async () => {
    const store = new MemoryScheduleStore(() => NOW);
    const r = await syncSchedules(
      store,
      [c('a.read'), c('a.write', WRITE_JOB), c('a.off', { enabled: false })],
      NOW,
    );
    expect(r.inserted.sort()).toEqual(['a.off', 'a.read', 'a.write']);
    const rows = await store.listSchedules();
    expect(rows.map((x) => [x.key, x.enabled, x.nextRunAt?.toISOString() ?? null, x.source])).toEqual([
      ['a.off', false, null, 'content'],
      ['a.read', true, '2026-10-15T12:15:00.000Z', 'content'],
      ['a.write', false, null, 'content'],
    ]);
    // A second sync with the same content changes nothing.
    expect(
      await syncSchedules(store, [c('a.read'), c('a.write', WRITE_JOB), c('a.off', { enabled: false })], NOW),
    ).toEqual({ inserted: [], updated: [] });
  });

  it('keeps an operator decision across content edits, but content can turn a schedule off', async () => {
    const store = new MemoryScheduleStore(() => NOW);
    await syncSchedules(store, [c('a.read'), c('a.off', { enabled: false })], NOW);
    const off = (await store.getSchedule('a.off'))!;
    await store.updateSchedule(off.id, { enabled: true });
    await syncSchedules(
      store,
      [
        c('a.read', { title: 'Renamed', cron: '0 * * * *' }),
        c('a.off', { enabled: false, summary: 'edited' }),
      ],
      NOW,
    );
    expect(await store.getSchedule('a.off')).toMatchObject({ enabled: true });
    expect(await store.getSchedule('a.read')).toMatchObject({
      enabled: true,
      nextRunAt: new Date('2026-10-15T13:00:00Z'),
      definition: { title: 'Renamed' },
    });
    await syncSchedules(
      store,
      [
        c('a.read', { title: 'Renamed', cron: '0 * * * *', enabled: false }),
        c('a.off', { enabled: false, summary: 'edited' }),
      ],
      NOW,
    );
    expect(await store.getSchedule('a.read')).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('drops the approval of a write-capable schedule whose definition changed', async () => {
    const store = new MemoryScheduleStore(() => NOW);
    await syncSchedules(store, [c('a.write', WRITE_JOB)], NOW);
    const row = (await store.getSchedule('a.write'))!;
    await store.updateSchedule(row.id, { enabled: true, approvedBy: 'blake@example.com' });
    await syncSchedules(store, [c('a.write', { ...WRITE_JOB, summary: 'changed inputs' })], NOW);
    expect(await store.getSchedule('a.write')).toMatchObject({
      enabled: false,
      approvedBy: null,
      nextRunAt: null,
    });
  });

  it('disables schedules removed from content, keeps their history, and leaves portal schedules alone', async () => {
    const store = new MemoryScheduleStore(() => NOW);
    await syncSchedules(store, [c('a.read')], NOW);
    await store.insertSchedule({
      key: 'local.mine',
      source: 'portal',
      definition: c('local.mine').def,
      sha256: 'x',
      enabled: true,
      nextRunAt: NOW,
    });
    const plan = planSync([], await store.listSchedules(), NOW);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates.map((u) => [u.key, u.patch])).toEqual([
      ['a.read', { enabled: false, nextRunAt: null }],
    ]);
  });

  it('repairs an enabled row without a next run', async () => {
    const store = new MemoryScheduleStore(() => NOW);
    await syncSchedules(store, [c('a.read')], NOW);
    const row = (await store.getSchedule('a.read'))!;
    await store.updateSchedule(row.id, { nextRunAt: null });
    await syncSchedules(store, [c('a.read')], NOW);
    expect((await store.getSchedule('a.read'))!.nextRunAt?.toISOString()).toBe('2026-10-15T12:15:00.000Z');
  });
});
