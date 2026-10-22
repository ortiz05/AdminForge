import type { PortalRole } from '@adminforge/schemas';
import { hasRole } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { DefinitionSource } from '../definitions/types';
import type { ScheduleRow, ScheduleRunRow } from './types';

/**
 * Who sees what a schedule's runs collected. Scheduled runs use application permissions, so their report files,
 * probe rows, run outputs and the error details in the run history are for the schedule's roles plus its report's or
 * playbook's own; a schedule that runs with its creator's access shows its files to the creator and Portal Admins.
 */

/** Who may see data a schedule collected with application permissions, unless its `requires.portalRoles` says otherwise. */
export const SCHEDULED_DATA_ROLES: readonly PortalRole[] = ['Portal.Operator'];

/**
 * Who opens the files of a schedule that runs with its creator's own access (ADR-014): the creator, or a Portal Admin
 * (`admin`, audited); anyone else is `denied`. `n/a` for other schedules (their roles decide).
 */
export function creatorFilesAccess(
  row: Pick<ScheduleRow, 'definition' | 'createdBy'>,
  session: SessionRecord,
): 'n/a' | 'creator' | 'admin' | 'denied' {
  const identity = row.definition.identity;
  if (!identity || identity === 'automation' || !('user' in identity)) return 'n/a';
  if (row.createdBy && row.createdBy === session.userOid) return 'creator';
  return hasRole(session, 'Portal.Admin') ? 'admin' : 'denied';
}

/** The schedule's `requires.portalRoles` (default: Operator) and its report's or playbook's own. */
export async function scheduleDataRoles(
  definitions: Pick<DefinitionSource, 'list'>,
  schedule: ScheduleRow['definition'] | undefined,
): Promise<PortalRole[]> {
  const roles: PortalRole[] = [...(schedule?.requires?.portalRoles ?? SCHEDULED_DATA_ROLES)];
  const job = schedule?.job;
  if (job?.kind === 'report' || job?.kind === 'playbook') {
    const ref = job.ref;
    const def = (await definitions.list(job.kind)).find((d) => d.key === ref)?.def as
      { requires?: { portalRoles?: PortalRole[] } } | undefined;
    roles.push(...(def?.requires?.portalRoles ?? []));
  }
  return [...new Set(roles)];
}

/**
 * Errors the scheduler writes itself, never from what a job read: a missed or interrupted run, a timeout, a schedule
 * that is gone. Their message stays for every viewer, like the reason of a skipped run (also the scheduler's).
 */
const SCHEDULER_ERRORS = new Set(['schedule_missed', 'schedule_not_found', 'interrupted', 'timeout']);

/** Whether a run's error message is the scheduler's own (shown to everyone who sees the history). */
export const schedulerWritten = (r: Pick<ScheduleRunRow, 'status' | 'error'>) =>
  r.status === 'skipped' || (!!r.error && SCHEDULER_ERRORS.has(r.error.code));

/** Why a viewer gets a run's status and error code only, or null when they may see its details. */
export type RunRestriction = { creatorOnly: true } | { roles: readonly PortalRole[] };

export function runRestriction(
  session: SessionRecord,
  files: boolean,
  roles: readonly PortalRole[],
): RunRestriction | null {
  if (files && roles.every((r) => hasRole(session, r))) return null;
  return files ? { roles } : { creatorOnly: true };
}

/** What a restricted viewer reads instead of a run's error message (the code stays; no hint). */
export function restrictedRunError(
  code: string,
  restriction: RunRestriction,
): { code: string; message: string } {
  return {
    code,
    message:
      'creatorOnly' in restriction
        ? 'The details are shown only to the person who created this schedule and portal administrators.'
        : `The details are shown only to people with the ${restriction.roles.join(' and ')} role.`,
  };
}

/** The history line of a file-only run (F-10), in the present while it is waiting or running. */
export function fileOnlyReason(r: Pick<ScheduleRunRow, 'status'>, report: boolean): string {
  const now = r.status === 'queued' || r.status === 'running';
  if (report)
    return now
      ? 'The schedule is disabled, so this run only writes the file: it sends no email, Teams message or notification.'
      : 'The schedule was disabled, so this run only wrote the file: it sent no email, Teams message or notification.';
  return now
    ? 'The schedule is disabled, so this run sends no email, Teams message or notification.'
    : 'The schedule was disabled, so this run sent no email, Teams message or notification.';
}
