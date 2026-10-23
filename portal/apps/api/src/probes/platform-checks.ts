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
 * The credentials from Vault (ADR-018): ok when every identity's secret was read at the last refresh; warn when the last
 * refresh failed (the last good credentials stay in use) or hasn't run yet; crit when an identity has nothing at its
 * path. Without Vault (the env file holds the credentials) it says so and is ok.
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
      message: 'Vault isn’t used here: the credentials come from the env file.',
    };
  const names = Object.entries(status.identities);
  const loaded = names.filter(([, s]) => s === 'loaded').length;
  const missing = names.filter(([, s]) => s === 'missing').map(([n]) => n);
  if (missing.length)
    return {
      metric: loaded,
      status: 'crit',
      code: 'credential_unavailable',
      message: `No credential in Vault for ${missing.join(', ')} (identities/<name> under AF_VAULT_PATH): its schedules and checks fail.`,
    };
  if (status.error)
    return {
      metric: loaded,
      status: 'warn',
      code: 'vault_unreachable',
      message: `${status.error} The last good credentials stay in use${status.lastRefreshAt ? ` (read ${status.lastRefreshAt})` : ''}.`,
    };
  if (!status.lastRefreshAt)
    return { metric: loaded, status: 'warn', code: 'vault_not_read', message: 'Vault hasn’t been read yet.' };
  return {
    metric: loaded,
    status: 'ok',
    message: `${loaded} credential${loaded === 1 ? '' : 's'} read from Vault at ${status.lastRefreshAt}.`,
  };
}
