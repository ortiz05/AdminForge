import { isWriteCapable } from './definition';
import type { Probe } from './probe';
import type { ProbeJob, Schedule, ScheduleIdentity } from './schedule';

/**
 * The installation's default accounts for read-only schedules (AF_SCHEDULE_DEFAULT_IDENTITY, …_REPORTS, …_PROBES):
 * `automation` or the name of a configured app identity (AF_SCHEDULE_IDENTITIES).
 */
export interface RunAsDefaults {
  /** Every read-only job that names no identity (AF_SCHEDULE_DEFAULT_IDENTITY). */
  all?: string;
  /** Report jobs (AF_SCHEDULE_DEFAULT_IDENTITY_REPORTS); `all` otherwise. */
  reports?: string;
  /** Probe jobs (AF_SCHEDULE_DEFAULT_IDENTITY_PROBES); `all` otherwise. */
  probes?: string;
}

/** Where a schedule's account comes from: set in the portal, named by its definition, a default, or neither. */
export type RunAsSource = 'override' | 'definition' | 'default' | 'automation';

/** AdminForge's own housekeeping always runs as the automation identity (the schedule schema says so too). */
const ALWAYS_AUTOMATION = new Set<string>(['news', 'contentHealth']);

const asIdentity = (name: string): ScheduleIdentity => (name === 'automation' ? 'automation' : { app: name });

/** The identity an `identityKey` string names (`automation`, `app:<name>`); null for anything else (`user` included). */
export function identityFromKey(key: string | null | undefined): ScheduleIdentity | null {
  if (key === 'automation') return 'automation';
  const m = /^app:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(key ?? '');
  return m ? { app: m[1]! } : null;
}

/**
 * Which account a schedule runs as (docs/plans/2026-10-23-run-as-and-vault.md): its portal `override`, else the
 * identity its definition names, else the installation default for its kind — for read-only jobs only, so a deploy
 * never moves a write-capable schedule to another account without the approval that enabling it needs — else the
 * automation identity. A parsed definition that names none says `automation` (the schema's default).
 */
export function effectiveIdentity(
  def: Schedule,
  opts: { override?: ScheduleIdentity | null; defaults?: RunAsDefaults } = {},
): { identity: ScheduleIdentity; source: RunAsSource } {
  if (ALWAYS_AUTOMATION.has(def.job.kind)) return { identity: 'automation', source: 'automation' };
  if (opts.override) return { identity: opts.override, source: 'override' };
  if (def.identity && def.identity !== 'automation') return { identity: def.identity, source: 'definition' };
  if (!isWriteCapable(def)) {
    const d = opts.defaults;
    const name =
      def.job.kind === 'report'
        ? (d?.reports ?? d?.all)
        : def.job.kind === 'probe'
          ? (d?.probes ?? d?.all)
          : d?.all;
    if (name) return { identity: asIdentity(name), source: 'default' };
  }
  return { identity: 'automation', source: 'automation' };
}

/**
 * Whether a probe job runs this probe — as the scheduler selects them (`selectProbes`): by `ref`, by `refs`, or every
 * active probe carrying all `select.tags`. Provisioning and content health credit a probe's permissions to the account
 * of each schedule that runs it.
 */
export function probeJobCovers(job: ProbeJob, probe: Pick<Probe, 'id' | 'tags' | 'status'>): boolean {
  if (job.ref) return job.ref === probe.id;
  if (job.refs) return job.refs.includes(probe.id);
  if (probe.status === 'draft' || probe.status === 'retired') return false;
  return (job.select?.tags ?? []).every((t) => probe.tags?.includes(t));
}
