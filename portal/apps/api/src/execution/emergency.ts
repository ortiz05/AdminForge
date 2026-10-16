import type { SettingsStore } from '../admin/settings-store';
import { AppError } from '../errors';

/**
 * Emergency stop (finding ENG-08): two installation flags in the `settings` table, set from Admin → Settings
 * (routes/emergency.ts) without host access or touching the enterprise apps in Entra.
 * - writes: every declared write (interactive and scheduled) is refused by the outbound executor; reads keep working.
 * - automation: the scheduler fires no schedules (each occurrence is recorded as skipped); runs already going finish.
 * Read from the database on every check, so every process (API, runs worker, scheduler) follows a change at once.
 */

export type PauseTarget = 'writes' | 'automation';

/** Settings keys of the two flags. */
export const PAUSE_KEYS: Record<PauseTarget, string> = {
  writes: 'emergency.writes',
  automation: 'emergency.automation',
};

export interface PauseState {
  paused: boolean;
  /** Why it was paused (required when pausing; shown to everyone signed in). */
  reason: string | null;
  /** UPN of who paused or resumed it last. */
  by: string | null;
  /** When (ISO). */
  at: string | null;
}

export interface PauseRecord extends PauseState {
  /** Settings version (0 = never set): the expected version of the next change. */
  version: number;
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/** The stored flag; anything but `paused: true` reads as running. */
export async function readPause(
  settings: Pick<SettingsStore, 'get'>,
  target: PauseTarget,
): Promise<PauseRecord> {
  const rec = await settings.get<unknown>(PAUSE_KEYS[target]);
  const v = (rec?.value && typeof rec.value === 'object' ? rec.value : {}) as Record<string, unknown>;
  return {
    paused: v.paused === true,
    reason: text(v.reason),
    by: text(v.by),
    at: text(v.at),
    version: rec?.version ?? 0,
  };
}

export const isPaused = async (settings: Pick<SettingsStore, 'get'>, target: PauseTarget) =>
  (await readPause(settings, target)).paused;

/** Refusal for a declared write while changes are paused. */
export const writesPausedError = () =>
  new AppError(
    503,
    'writes_paused',
    'An administrator has paused all changes through AdminForge, so this change wasn’t made.',
    {
      hint: 'Reads keep working. A Portal Admin can resume changes under Admin → Settings; the Audit page shows who paused them and why.',
    },
  );

/** Why a schedule occurrence was skipped while automation is paused (shown in the schedule's history). */
export const AUTOMATION_PAUSED = {
  code: 'automation_paused',
  message: 'Skipped: an administrator has paused automation, so schedules don’t run.',
  hint: 'A Portal Admin can resume automation under Admin → Settings; the Audit page shows who paused it and why.',
} as const;
