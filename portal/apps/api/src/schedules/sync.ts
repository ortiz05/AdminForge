import { isWriteCapable, type Schedule } from '@adminforge/schemas';
import type { DefinitionSource } from '../definitions/types';
import { nextRun } from './cron';
import type { ScheduleStore } from './store';
import type { NewSchedule, SchedulePatch, ScheduleRow } from './types';

/**
 * Content → `schedules` (R6). Content is the source of the *definition*; the row holds the operational state
 * (enabled, approval, next/last run). Rules:
 * - A new content schedule starts **disabled**, unless its YAML says `enabled: true` and it is read-only (a write-capable
 *   schedule always needs a second person's approval before it runs) and it is not a draft.
 * - When the content changes (sha256), content can turn a schedule off (`enabled: true` → `false`, or draft/retired)
 *   but never on; a write-capable schedule — or any schedule that was approved — whose definition changed loses its
 *   approval and is disabled until someone approves (or enables) the new definition. Whether the new version still
 *   writes is not trusted: its playbook's children decide that at run time.
 * - A content schedule that disappears is disabled (the row and its history stay).
 */

export interface ContentSchedule {
  key: string;
  def: Schedule;
  sha256: string;
}

export interface SyncPlan {
  inserts: NewSchedule[];
  updates: Array<{ id: string; key: string; patch: SchedulePatch; expectSha256: string }>;
}

const inactiveStatus = (def: Schedule) => def.status === 'draft' || def.status === 'retired';

/** Whether a schedule may start enabled straight from content. */
export const initiallyEnabled = (def: Schedule) =>
  def.enabled && !isWriteCapable(def) && !inactiveStatus(def);

const nextFor = (def: Schedule, now: Date): Date | null => {
  try {
    return nextRun(def.cron, def.timezone, now);
  } catch {
    return null;
  }
};

/** Pure: what to insert/update so the store matches content. */
export function planSync(
  content: readonly ContentSchedule[],
  rows: readonly ScheduleRow[],
  now: Date,
): SyncPlan {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const inContent = new Set(content.map((c) => c.key));
  const plan: SyncPlan = { inserts: [], updates: [] };
  for (const c of content) {
    const row = byKey.get(c.key);
    if (!row) {
      const enabled = initiallyEnabled(c.def);
      plan.inserts.push({
        key: c.key,
        source: 'content',
        definition: c.def,
        sha256: c.sha256,
        enabled,
        nextRunAt: enabled ? nextFor(c.def, now) : null,
      });
      continue;
    }
    if (row.source !== 'content') continue;
    if (row.sha256 !== c.sha256) {
      // An approval covered the definition it was given for: any change voids it, whatever the new version says.
      const approved = !!row.approvedBy || !!row.approvedTarget;
      const write = isWriteCapable(c.def) || approved;
      // Content turns a schedule off only by changing `enabled: true` to `false` (an operator's choice otherwise stands).
      const turnedOff = row.definition.enabled !== false && c.def.enabled === false;
      const enabled = row.enabled && !turnedOff && !inactiveStatus(c.def) && !write;
      const patch: SchedulePatch = {
        definition: c.def,
        sha256: c.sha256,
        enabled,
        nextRunAt: enabled ? nextFor(c.def, now) : null,
      };
      if (write) {
        patch.approvedBy = null;
        patch.approvedTarget = null;
        patch.approvedIdentity = null;
      }
      plan.updates.push({ id: row.id, key: row.key, patch, expectSha256: row.sha256 });
    } else if (row.enabled && (!row.nextRunAt || Number.isNaN(row.nextRunAt.getTime()))) {
      plan.updates.push({
        id: row.id,
        key: row.key,
        patch: { nextRunAt: nextFor(c.def, now) },
        expectSha256: row.sha256,
      });
    }
  }
  for (const row of rows)
    if (row.source === 'content' && !inContent.has(row.key) && row.enabled)
      plan.updates.push({
        id: row.id,
        key: row.key,
        patch: { enabled: false, nextRunAt: null },
        expectSha256: row.sha256,
      });
  return plan;
}

/** Content schedules from the registry (latest non-retired version of each). */
export async function contentSchedules(
  definitions: Pick<DefinitionSource, 'list'>,
): Promise<ContentSchedule[]> {
  return (await definitions.list('schedule')).map((r) => ({
    key: r.key,
    def: r.def as Schedule,
    sha256: r.sha256,
  }));
}

/** Applies the plan (conflicting concurrent changes are skipped; the next sync converges). Returns the keys changed. */
export async function syncSchedules(
  store: ScheduleStore,
  content: readonly ContentSchedule[],
  now: Date,
): Promise<{ inserted: string[]; updated: string[] }> {
  const plan = planSync(content, await store.listSchedules(), now);
  const inserted: string[] = [];
  const updated: string[] = [];
  for (const row of plan.inserts) if (await store.insertSchedule(row)) inserted.push(row.key);
  for (const u of plan.updates)
    if (await store.updateSchedule(u.id, u.patch, { sha256: u.expectSha256 })) updated.push(u.key);
  return { inserted, updated };
}

/** Stable signature of the content schedules (re-sync only when it changes). */
export const contentSignature = (content: readonly ContentSchedule[]) =>
  content
    .map((c) => `${c.key}@${c.sha256}`)
    .sort()
    .join('|');
