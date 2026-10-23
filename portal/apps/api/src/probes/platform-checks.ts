import type { ProbeCheck } from '@adminforge/schemas';
import type { CheckContext, CheckResult } from './checks';

// AdminForge's own platform checks (`group: platform` probes), split from checks.ts (O-04): the audit chain, and the
// credentials read from HashiCorp Vault.

export async function auditChain(
  _c: Extract<ProbeCheck, { kind: 'auditChain' }>,
  x: CheckContext,
): Promise<CheckResult> {
  if (!x.deps.audit)
    return {
      metric: null,
      status: 'error',
      code: 'not_configured',
      message: 'No audit log in this process.',
    };
  // Hourly from the last verified checkpoint, the whole chain at start and daily (D-05); a writer without
  // checkpoints (memory) walks it all every time.
  const audit = x.deps.audit;
  const r = audit.verifyIncremental
    ? await audit.verifyIncremental()
    : { ...(await audit.verify()), scope: 'full' as const };
  return r.ok
    ? {
        metric: r.count,
        status: 'ok',
        message: `${
          r.scope === 'incremental'
            ? `${r.checked} new audit event${r.checked === 1 ? '' : 's'} verified since the last check (${r.count} in all); the whole chain is re-walked daily.`
            : `${r.count} audit event${r.count === 1 ? '' : 's'} verified (the whole chain); every hash links to the one before it.`
        }${r.lostKey ? ` The events from seq ${r.lostKey.seq} keyed with a key declared lost (id ${r.lostKey.keyId}) are checked for links only.` : ''}`,
      }
    : r.missingKey
      ? {
          metric: r.brokenAt,
          status: 'crit',
          code: 'audit_chain_key_missing',
          message: `The audit chain can't be verified from event #${r.brokenAt} (seq ${r.seq}): it is keyed with a key that isn't configured (key id ${r.missingKey}). After a key rotation, put the earlier key in AUDIT_CHAIN_PREVIOUS_KEYS; if no such key was ever configured, the event was forged — investigate database access.`,
        }
      : {
          metric: r.brokenAt,
          status: 'crit',
          code: 'audit_chain_broken',
          message: `The audit chain is broken at event #${r.brokenAt} (seq ${r.seq}): an event was changed or removed. Run \`adminforge audit verify\` and investigate database access.`,
        };
}

/**
 * The credentials from Vault (ADR-018): ok when every identity's secret was read at the last refresh; warn when a read
 * failed but the identity's last good credential stays in use, or nothing was read yet; crit when an identity has no
 * usable credential (nothing at its path, or never read). Messages name identities only; which Vault path failed and
 * how is in the details, which only Operators see. Without Vault (the env file holds the credentials) it is ok.
 */
export async function vaultCredentials(
  _c: Extract<ProbeCheck, { kind: 'vaultCredentials' }>,
  x: CheckContext,
): Promise<CheckResult> {
  const status = x.deps.vault?.() ?? null;
  if (!status)
    return {
      metric: null,
      status: 'ok',
      message: 'Vault isn’t used here: the credentials come from the installation’s settings.',
    };
  const names = Object.entries(status.identities);
  const inState = (...states: string[]) => names.filter(([, s]) => states.includes(s)).map(([n]) => n);
  const usable = inState('loaded', 'stale').length;
  const details = {
    rows: names.map(([identity, state]) => ({ identity, state, problem: status.errors[identity] ?? null })),
  };
  const list = (n: string[]) => n.join(', ');
  const none = inState('missing', 'unavailable');
  if (none.length)
    return {
      metric: usable,
      status: 'crit',
      code: 'credential_unavailable',
      message: `No usable credential from Vault for ${list(none)}: its schedules and checks fail.`,
      details,
    };
  const stale = inState('stale');
  if (stale.length)
    return {
      metric: usable,
      status: 'warn',
      code: 'vault_unreachable',
      message: `Vault couldn’t be read for ${list(stale)}; the credentials read earlier stay in use.`,
      details,
    };
  if (!status.lastRefreshAt || inState('not_read').length)
    return {
      metric: usable,
      status: 'warn',
      code: 'vault_not_read',
      message: 'Vault hasn’t been read yet.',
      details,
    };
  return {
    metric: usable,
    status: 'ok',
    message: `${usable} credential${usable === 1 ? '' : 's'} read from Vault (checked ${status.lastRefreshAt}).`,
    details,
  };
}
