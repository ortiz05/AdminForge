import {
  IdentityUnavailable,
  type Actor,
  type IdentityResolver,
  type ResolvedIdentity,
  type RunRecord,
} from '@adminforge/engine';
import { randomUUID } from 'node:crypto';
import type { Mode } from '@adminforge/connectors';
import type { RoleCheck } from '../auth/session-plugin';
import { isArmed, type SessionRecord, type SessionStore } from '../auth/session-store';
import type { ExecutionIdentity } from '../execution/types';
import { sessionBinding, type RunRepository } from './types';

/**
 * ADR-010/011 for the engine: a delegated run acts through the session bound to the actor — the initiator's session
 * (`runs.session_hash`), or after an approval the approver's (`approvals.decisions[].sessionHash`). A missing,
 * expired or idle session parks the run in `awaiting_reauth`; a write step without an armed session parks it in
 * `awaiting_arm` — as does one bound before its session gained write access (`prearm:`, S-08) until it is resumed.
 * `POST /api/runs/:id/resume` rebinds the caller's current session. Automation runs use the
 * automation identity.
 *
 * The session's roles are re-confirmed with Entra (the API's RoleCheck, every 5 minutes) before it is used, so a run
 * nobody watches stops acting for someone whose access was removed: losing Operator drops write access (the next write
 * step parks in `awaiting_arm`), and a session left without a role, or refused by Entra, ends (`awaiting_reauth`).
 */
export class SessionIdentityResolver implements IdentityResolver {
  /** Portal roles seen per oid (for `user.roles` in expressions). */
  readonly roles = new Map<string, string[]>();

  constructor(
    private readonly repo: RunRepository,
    private readonly sessions: SessionStore,
    private readonly config: { SESSION_IDLE_MINUTES: number },
    private readonly now: () => Date,
    private readonly opts: {
      /** Keeps the session's roles current (absent without Entra: mock mode and tests). */
      roleCheck?: Pick<RoleCheck, 'check'>;
      log?: { warn(obj: object, msg: string): void };
    } = {},
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

  /**
   * The live session for a hash with its roles confirmed, or null when it is gone, expired or idle — or ended by the
   * role re-check (no AdminForge role left, account disabled or a guest, roles unconfirmed for too long). With
   * `expectOid`, also null when the session belongs to someone else: a session hash recorded for a person (as initiator
   * or on their approval decision) only ever acts as that person, whatever the stored row says.
   */
  async liveSession(
    binding: string | null,
    origin: { correlationId?: string; runId?: string } = {},
    expectOid?: string | null,
  ): Promise<SessionRecord | null> {
    const { hash } = sessionBinding(binding);
    if (!hash) return null;
    const s = await this.sessions.get(hash);
    const at = this.now();
    const now = at.getTime();
    if (s && expectOid !== undefined && s.userOid !== expectOid) {
      this.opts.log?.warn(
        { runId: origin.runId },
        'a run step was bound to a session of another person; refusing to act with it',
      );
      return null;
    }
    if (
      !s ||
      s.expiresAt.getTime() <= now ||
      s.lastSeenAt.getTime() + this.config.SESSION_IDLE_MINUTES * 60_000 <= now
    )
      return null;
    const current = this.opts.roleCheck
      ? await this.opts.roleCheck.check(s, at, {
          correlationId: origin.correlationId ?? randomUUID(),
          ...(origin.runId ? { runId: origin.runId } : {}),
          ...(this.opts.log ? { log: this.opts.log } : {}),
        })
      : s;
    if (!current) return null;
    this.roles.set(current.userOid, current.roles);
    return current;
  }

  async resolve(run: RunRecord, actor: Actor, mode: Mode): Promise<ResolvedIdentity> {
    if (run.identity === 'automation')
      return {
        actor,
        mode,
        // A schedule that names an app identity runs as it (ADR-014), children included.
        handle: {
          kind: 'automation',
          mode,
          ...(run.identityName ? { app: run.identityName } : {}),
        } satisfies ExecutionIdentity,
      };
    const who = actor.upn ?? 'The engineer running this';
    const binding = await this.sessionFor(run.id, actor);
    const session = await this.liveSession(
      binding,
      { correlationId: run.correlationId, runId: run.id },
      actor.oid ?? null,
    );
    if (!session)
      throw new IdentityUnavailable('reauth', `${who} needs to sign in again, then resume the run.`);
    if (mode === 'write' && !isArmed(session, this.now()))
      throw new IdentityUnavailable('not_armed', `${who} needs to arm write access, then resume the run.`);
    // S-08: bound before the session gained write access — it reads on, but writes only once the person resumes it.
    if (mode === 'write' && sessionBinding(binding).prearm)
      throw new IdentityUnavailable(
        'not_armed',
        `${who} turned on write access after this run started. Resume it to let it make changes.`,
      );
    return { actor, mode, handle: { kind: 'delegated', session, mode } satisfies ExecutionIdentity };
  }
}
