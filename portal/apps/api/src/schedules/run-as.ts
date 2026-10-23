import {
  effectiveIdentity,
  identityFromKey,
  type RunAsDefaults,
  type ScheduleIdentity,
  identityKey,
} from '@adminforge/schemas';
import { AppError } from '../errors';
import type { ScheduleRow } from './types';

/**
 * The account a schedule runs as now (docs/plans/2026-10-23-run-as-and-vault.md): the override an Operator chose
 * (content schedules — portal schedules change theirs in the editor), else what its definition names, else the
 * installation default for its kind (read-only jobs), else the automation identity.
 */
export const runAsOf = (
  row: Pick<ScheduleRow, 'definition' | 'source' | 'runAs'>,
  defaults?: RunAsDefaults,
) =>
  effectiveIdentity(row.definition, {
    override: row.source === 'content' ? identityFromKey(row.runAs) : null,
    ...(defaults ? { defaults } : {}),
  });

/** The named app identity an identity is, or null (the automation identity, or the creator). */
export const appNameOf = (identity: ScheduleIdentity): string | null =>
  identity !== 'automation' && 'app' in identity ? identity.app : null;

/**
 * Why a write-capable schedule may not run now, or null: nobody approved enabling it, or its account changed after the
 * approval (`approvedIdentity`; an approval from before accounts were recorded covers the definition's account).
 */
export function writeRunRefusal(
  s: Pick<ScheduleRow, 'approvedBy' | 'approvedIdentity' | 'definition'>,
  runningAs: ScheduleIdentity,
): AppError | null {
  if (!s.approvedBy)
    return new AppError(
      403,
      'approval_required',
      'This schedule changes data and runs only after a second person approved enabling it.',
    );
  if ((s.approvedIdentity ?? identityKey(s.definition.identity)) !== identityKey(runningAs))
    return new AppError(
      403,
      'approval_required',
      'The account this schedule runs as changed after its approval; a second person must approve the new account.',
    );
  return null;
}
