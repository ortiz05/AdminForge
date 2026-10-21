import { EyeSlashIcon } from '@adminforge/ui';
import { Callout } from '../ops/ui';

/**
 * S-25: someone else's delegated run. It ran with that person's own access, so its inputs, results, logs and error
 * details stay with them, its approvers and Portal Admins; the run and runbook pages say so instead of showing empty
 * panels.
 */
export function RunDataHidden({ initiator }: { initiator: string | null }) {
  const who = initiator ?? 'the person who started it';
  return (
    <Callout
      tone="neutral"
      icon={<EyeSlashIcon size={18} />}
      title={`Only ${who} can see the inputs and results`}
    >
      It ran with {initiator ? `${initiator}’s` : 'their'} own access, so what it ran with, what it found, its
      logs and error details are shown only to them, the run’s approvers and Portal Admins. Ask {who} if you
      need them.
    </Callout>
  );
}

/** A failed step's error as a metadata-only viewer gets it (S-25): the code, not the withheld message. */
export function ErrorCode({ code }: { code: string }) {
  return (
    <code className="font-mono text-xs">
      <span className="sr-only">Error code </span>
      {code}
    </code>
  );
}
