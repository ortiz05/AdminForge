import { createHash } from 'node:crypto';
import {
  containsRedacted,
  IdentityUnavailable,
  isTerminal,
  redactedValueError,
  StepError,
  type Actor,
  validateInputs,
  type AutomationDefinition,
  type ChildRunner,
  type ChildRunRequest,
  type ChildRunResult,
  type Engine,
} from '@adminforge/engine';
import type { AuditWriter } from '../audit/writer';
import type { DefinitionResolver } from '../definitions/types';
import type { SessionIdentityResolver } from './identity';
import type { RepositoryRunStore } from './store';
import { runAuditActor } from './store';
import type { RunRepository } from './types';

/** Deterministic child run id for (parent run, step path): resuming the parent continues the same child (UUID v5 layout). */
export function childRunId(parentId: string, path: string): string {
  const h = createHash('sha256').update(`adminforge.child:${parentId}:${path}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Runs `type: playbook` steps (and bulk items) as child runs executed inline by the parent's worker: each child is a
 * `runs` row (trigger `child`, parent_run_id) with its own steps, approvals and audit trail; parks and decisions on a
 * child park/resume the parent (the worker always drives the root run).
 */
export class RunChildRunner implements ChildRunner {
  constructor(
    private readonly deps: {
      repo: RunRepository;
      store: RepositoryRunStore;
      identity: SessionIdentityResolver;
      definitions: () => DefinitionResolver;
      engine: () => Engine;
      audit: AuditWriter;
      env: () => Record<string, unknown>;
      now: () => Date;
    },
  ) {}

  async run(req: ChildRunRequest): Promise<ChildRunResult> {
    const { repo } = this.deps;
    const parent = await repo.getRun(req.parent.id);
    if (!parent) throw new StepError('child_failed', 'Parent run not found.');
    const id = childRunId(parent.id, req.path);
    let row = await repo.getRun(id);
    let def: AutomationDefinition;
    if (row) {
      const resolved = await this.resolve(req.ref, row.definitionVersion);
      if (resolved.sha256 !== row.definitionSha256)
        throw new StepError(
          'definition_changed',
          `${req.ref}@${row.definitionVersion} changed after this run started.`,
        );
      def = resolved.def;
    } else {
      // Inputs built from a masked value after the parent paused would start the child with "[redacted]".
      if (containsRedacted(req.inputs)) throw redactedValueError();
      // ENG-07: a child starts on the current published version only, like a run started directly or a bulk item
      // (an older version may lack roles, approvals or fixes added since). A pin is honoured while it is current.
      const resolved = await this.resolve(req.ref);
      if (req.version && req.version !== resolved.version)
        throw new StepError(
          'version_superseded',
          `${resolved.def.title} was updated to version ${resolved.version}; this playbook pins version ${req.version}, which can no longer run.`,
          {
            hint: "Ask the playbook's owner to update the pinned version (or remove the pin to always use the current one).",
          },
        );
      def = resolved.def;
      if (def.status === 'retired') throw new StepError('definition_retired', `${req.ref} is retired.`);
      if (def.status === 'draft' && !req.dryRun)
        throw new StepError('definition_draft', `${def.title} is a draft and can't run yet.`, {
          hint: 'It can run once its owner publishes it with status: published.',
        });
      const v = await validateInputs(def.inputs, req.inputs, { now: this.deps.now(), env: this.deps.env() });
      if (!v.ok)
        throw new StepError(
          'invalid_inputs',
          `Inputs for ${req.ref}: ${v.errors.map((e) => `${e.field || 'inputs'}: ${e.message}`).join('; ')}`,
        );
      const automation = parent.identity === 'automation';
      const sessionHash = automation
        ? null
        : req.actor.oid === parent.initiatorOid
          ? parent.sessionHash
          : await this.deps.identity.sessionFor(parent.id, req.actor);
      if (!automation) await this.checkRoles(def, sessionHash, req.actor);
      row = await repo.insertRunIfAbsent({
        id,
        kind: def.kind,
        definitionKey: def.id,
        definitionVersion: resolved.version,
        definitionSha256: resolved.sha256,
        dryRun: req.dryRun,
        trigger: 'child',
        identity: parent.identity,
        initiatorOid: automation ? parent.initiatorOid : req.actor.oid,
        initiatorUpn: automation ? parent.initiatorUpn : req.actor.upn,
        sessionHash,
        scheduleId: parent.scheduleId,
        parentRunId: parent.id,
        inputs: v.values,
        correlationId: parent.correlationId,
      });
      await this.deps.audit.append({
        ...runAuditActor(row, req.actor),
        mode: null,
        action: 'run.created',
        targetType: 'run',
        targetId: id,
        details: {
          definition: def.id,
          version: resolved.version,
          dryRun: req.dryRun,
          trigger: 'child',
          parentRunId: parent.id,
          path: req.path,
        },
        result: 'success',
        correlationId: parent.correlationId,
      });
    }
    if (!isTerminal(row.status)) {
      this.deps.store.bind(id, def);
      const out = await this.deps.engine().execute(id, def, { depth: req.depth, signal: req.signal });
      return {
        runId: id,
        status: out.status,
        outputs: out.outputs ?? null,
        error: out.error ?? null,
        plan: await this.plan(id),
        ...(out.wakeAt ? { wakeAt: out.wakeAt } : {}),
      };
    }
    return {
      runId: id,
      status: row.status,
      outputs: row.outputs,
      error: row.error,
      plan: await this.plan(id),
    };
  }

  /**
   * A child playbook runs as the parent's current actor (the initiator, or the approver after an approval), who needs
   * the roles the child requires — the same rule as starting it directly.
   */
  private async checkRoles(def: AutomationDefinition, sessionHash: string | null, actor: Actor) {
    const required = def.requires?.portalRoles ?? [];
    if (!required.length) return;
    const who = actor.upn ?? 'The engineer running this';
    const session = await this.deps.identity.liveSession(sessionHash, {}, actor.oid ?? null);
    if (!session)
      throw new IdentityUnavailable('reauth', `${who} needs to sign in again, then resume the run.`);
    const missing = required.filter((r) => !session.roles.includes(r));
    if (missing.length)
      throw new StepError(
        'forbidden',
        `${def.title} needs the ${missing.join(' and ')} role, which ${actor.upn ?? 'the engineer running this'} doesn't have.`,
        { hint: 'Ask a portal administrator for the role, or ask someone who has it to run this playbook.' },
      );
  }

  private async plan(runId: string) {
    return (await this.deps.repo.listSteps(runId)).flatMap((r) => r.plan ?? []);
  }

  /** The exact version (an existing child run), else the current published one (retired or never published: fails). */
  private async resolve(ref: string, version?: string) {
    try {
      return await this.deps.definitions().resolve('playbook', ref, version);
    } catch {
      throw new StepError(
        'child_not_found',
        `Playbook ${ref}${version ? `@${version}` : ''} is not published.`,
        { hint: "It may have been retired. Ask the playbook's owner to update or remove this step." },
      );
    }
  }
}
