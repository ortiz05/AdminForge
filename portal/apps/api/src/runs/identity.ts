import {
  IdentityUnavailable,
  type Actor,
  type IdentityResolver,
  type ResolvedIdentity,
  type RunRecord,
} from '@adminforge/engine';
import type { Mode } from '@adminforge/connectors';
import { isArmed, type SessionRecord, type SessionStore } from '../auth/session-store';
import type { ExecutionIdentity } from '../execution/types';
import type { RunRepository } from './types';

/**
 * ADR-010/011 for the engine: a delegated run acts through the session bound to the actor — the initiator's session
 * (`runs.session_hash`), or after an approval the approver's (`approvals.decisions[].sessionHash`). A missing,
 * expired or idle session parks the run in `awaiting_reauth`; a write step without an armed session parks it in
 * `awaiting_arm`. `POST /api/runs/:id/resume` rebinds the caller's current session. Automation runs use the
 * automation identity.
 */
export class SessionIdentityResolver implements IdentityResolver {
  /** Portal roles seen per oid (for `user.roles` in expressions). */
  readonly roles = new Map<string, string[]>();

  constructor(
    private readonly repo: RunRepository,
    private readonly sessions: SessionStore,
    private readonly config: { SESSION_IDLE_MINUTES: number },
    private readonly now: () => Date,
  ) {}

  /** Session hash bound to `actor` in this run (initiator or an approver who decided on it). */
  async sessionFor(runId: string, actor: Pick<Actor, 'oid'>): Promise<string | null> {
    const row = await this.repo.getRun(runId);
    if (!row || !actor.oid) return null;
    if (row.initiatorOid === actor.oid && row.sessionHash) return row.sessionHash;
    const tasks = await this.repo.listTasks({ runId });
    let hash: string | null = null;
    for (const t of tasks)
      for (const d of t.decisions) if (d.oid === actor.oid && d.sessionHash) hash = d.sessionHash;
    return hash;
  }

  /** The live session for a hash, or null when it is gone, expired or idle. */
  async liveSession(hash: string | null): Promise<SessionRecord | null> {
    if (!hash) return null;
    const s = await this.sessions.get(hash);
    const now = this.now().getTime();
    if (
      !s ||
      s.expiresAt.getTime() <= now ||
      s.lastSeenAt.getTime() + this.config.SESSION_IDLE_MINUTES * 60_000 <= now
    )
      return null;
    this.roles.set(s.userOid, s.roles);
    return s;
  }

  async resolve(run: RunRecord, actor: Actor, mode: Mode): Promise<ResolvedIdentity> {
    if (run.identity === 'automation')
      return { actor, mode, handle: { kind: 'automation', mode } satisfies ExecutionIdentity };
    const who = actor.upn ?? 'The engineer running this';
    const session = await this.liveSession(await this.sessionFor(run.id, actor));
    if (!session)
      throw new IdentityUnavailable('reauth', `${who} needs to sign in again, then resume the run.`);
    if (mode === 'write' && !isArmed(session, this.now()))
      throw new IdentityUnavailable('not_armed', `${who} needs to arm write access, then resume the run.`);
    return { actor, mode, handle: { kind: 'delegated', session, mode } satisfies ExecutionIdentity };
  }
}
