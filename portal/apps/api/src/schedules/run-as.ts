import {
  effectiveIdentity,
  identityFromKey,
  type RunAsDefaults,
  type ScheduleIdentity,
} from '@adminforge/schemas';
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
