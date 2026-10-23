// PUT /api/schedules/:key/run-as, split from service.ts (O-04): choosing the account a content schedule runs as.
import {
  identityFromKey,
  identityKey,
  identityLabel,
  isWriteCapable,
  probeJobCovers,
  TRANSACTION_KINDS,
  type Probe,
  type RunAsDefaults,
  type ScheduleIdentity,
} from '@adminforge/schemas';
import type { AuditWriter } from '../audit/writer';
import { requireRole } from '../auth/guards';
import type { DefinitionSource } from '../definitions/types';
import { AppError } from '../errors';
import { appNameOf, runAsOf } from './run-as';
import type { ScheduleService } from './service';
import type { ScheduleStore } from './store';
import { actorOf, type Caller } from './views';

/** What choosing an account needs from the schedules service's dependencies. */
export interface RunAsDeps {
  store: ScheduleStore;
  definitions: Pick<DefinitionSource, 'list'>;
  audit: AuditWriter;
  now: () => Date;
  defaults?: RunAsDefaults;
  apps?: () => readonly string[];
  permissionsMissing?: (
    identity: ScheduleIdentity,
    scopes: Readonly<Partial<Record<string, readonly string[] | undefined>>>,
  ) => Promise<string[] | null>;
}

/**
 * PUT /api/schedules/:key/run-as: the account a content schedule runs as, over what its definition names (null =
 * back to the definition or the installation default). Portal.Operator; audited. The identity must hold the
 * application permissions the schedule declares; a write-capable schedule is turned off, and turning it on again
 * goes through two-person approval for the new account.
 */
export async function setRunAs(
  svc: Pick<ScheduleService, 'row' | 'changed'>,
  deps: RunAsDeps,
  c: Caller,
  key: string,
  wanted: string | null,
): Promise<{ disabled: boolean }> {
  requireRole(c.session, 'Portal.Operator', 'Choosing the account a schedule runs as');
  const { row } = await svc.row(key);
  const def = row.definition;
  if (row.source !== 'content')
    throw new AppError(
      409,
      'run_as_in_editor',
      'This schedule was made in the portal: change its account in its editor.',
      {
        hint: 'Open the schedule and choose Edit.',
      },
    );
  if (def.job.kind === 'news' || def.job.kind === 'contentHealth')
    throw new AppError(409, 'run_as_fixed', `${def.title} always runs as the automation identity.`);
  // A probe sweep runs its probes with the account's token: their permissions count, and synthetic transactions
  // (they send, upload or create on test objects; ADR-015) keep the account their content names.
  const job = def.job;
  const probes =
    job.kind === 'probe'
      ? (await deps.definitions.list('probe'))
          .map((r) => r.def as Probe)
          .filter((p) => probeJobCovers(job, p))
      : [];
  if (probes.some((p) => (TRANSACTION_KINDS as readonly string[]).includes(p.check.kind)))
    throw new AppError(
      409,
      'run_as_fixed',
      `${def.title} runs synthetic transactions, which change test objects: its account is set in content.`,
    );
  const identity = wanted === null ? null : identityFromKey(wanted);
  if (
    wanted !== null &&
    (!identity || (identity !== 'automation' && !(deps.apps?.() ?? []).includes(appNameOf(identity)!)))
  )
    throw new AppError(400, 'unknown_identity', 'There is no such identity on this AdminForge.', {
      hint: 'Choose the automation identity or an app identity listed in AF_SCHEDULE_IDENTITIES.',
    });
  const before = runAsOf(row, deps.defaults).identity;
  const after = runAsOf({ ...row, runAs: wanted }, deps.defaults).identity;
  // The application permissions it declares, per service (function connections aren't app roles).
  const scopes: Record<string, string[]> = {};
  for (const s of [def.requires?.scopes, ...probes.map((p) => p.requires?.scopes)])
    for (const [svc, list] of Object.entries(s ?? {}))
      if (Array.isArray(list) && list.length) scopes[svc] = [...new Set([...(scopes[svc] ?? []), ...list])];
  if (identityKey(after) !== identityKey(before) && Object.keys(scopes).length) {
    const missing = await deps.permissionsMissing?.(after, scopes);
    if (missing?.length)
      throw new AppError(
        409,
        'identity_lacks_permissions',
        `The ${identityLabel(after)} lacks permissions this schedule needs: ${missing.join(', ')}.`,
        { hint: 'Choose another account, or ask an AdminForge administrator to grant these permissions.' },
      );
  }
  const now = deps.now();
  // Write-capable: the approval covers the account, so a new one is approved again — turned off, its approval and
  // any pending request dropped (the scheduler also refuses a run as an account it wasn't approved for).
  const writes = isWriteCapable(def);
  const disabled = writes && row.enabled;
  await deps.store.updateSchedule(row.id, {
    runAs: wanted,
    runAsSetBy: wanted === null ? null : c.session.upn,
    runAsSetAt: wanted === null ? null : now,
    ...(writes ? { enabled: false, nextRunAt: null, approvedBy: null, approvedIdentity: null } : {}),
  });
  if (writes)
    for (const a of await deps.store.listApprovals({ status: 'pending', subjectId: key }))
      if (a.subjectId === key)
        await deps.store.updateApproval(a.id, { status: 'cancelled', decidedAt: now }, 'pending');
  await deps.audit.append({
    ...actorOf(c),
    action: 'schedule.run_as_changed',
    targetType: 'schedule',
    targetId: key,
    result: 'success',
    details: { from: identityKey(before), to: identityKey(after), override: wanted, disabled },
  });
  svc.changed(key);
  return { disabled };
}
