import { LockSimpleIcon } from '@adminforge/ui';
import { Callout } from '../ops/ui';

/**
 * S-25: someone else's delegated run. It ran with that person's own access, so its inputs, results, logs and error
 * details stay with them, its approvers and Portal.Admin; the run and runbook pages say so instead of showing empty
 * panels.
 */
export function RunDataHidden({ initiator }: { initiator: string | null }) {
  const who = initiator ?? 'the person who started it';
  return (
    <Callout
      tone="neutral"
      icon={<LockSimpleIcon size={18} />}
      title={`Only ${who} can see the inputs and results`}
    >
      The run used their own access, so what it ran with, what it found, its logs and its error details are
      shown only to them, the run’s approvers and Portal.Admin. You can see what ran, when and how each step
      ended.
    </Callout>
  );
}
