import { createHash } from 'node:crypto';
import {
  flattenSteps,
  walkSteps,
  type Compensation,
  type Playbook,
  type Runbook,
  type Step,
} from '@adminforge/schemas';

export interface PlaybookRef {
  ref: string;
  version?: string;
}

type Resolve = (
  ref: string,
  version?: string,
) => Promise<{ def: Playbook | Runbook; version: string; sha256: string }>;

/** The current published connection (function steps resolve theirs when they run). */
export type ResolveConnection = (key: string) => Promise<{ version: string; sha256: string }>;

/** Every playbook a run of `def` can start: child `playbook` steps and `playbook` compensations, at any depth. */
export function childRefs(def: Playbook | Runbook): PlaybookRef[] {
  const refs: PlaybookRef[] = [];
  walkSteps(flattenSteps(def), (step) => {
    if (step.type === 'playbook') refs.push({ ref: step.ref, version: step.version });
    const c = step.compensate;
    if (c?.type === 'playbook') refs.push({ ref: c.ref, version: c.version });
  });
  return refs;
}

/** Every connection `def` calls: `function` steps and `function` compensations (child playbooks not included). */
export function connectionRefs(def: Playbook | Runbook): string[] {
  const keys = new Set<string>();
  const add = (s: Step | Compensation | undefined) => {
    if (s?.type === 'function') keys.add(s.connection);
  };
  walkSteps(flattenSteps(def), (step) => {
    add(step);
    add(step.compensate);
  });
  return [...keys];
}

const MAX_DEPTH = 8;

/**
 * What a schedule approval covers: sha256 over `ref@version#sha256` of the playbook and, recursively, every playbook
 * it can start, plus `connection:key@version#sha256` of every connection their function steps call (a connection
 * resolves to its current version when the step runs, so a new one would otherwise slip under an old approval).
 * Publishing a new version of any of them changes the fingerprint, so the approval no longer applies.
 *
 * `resolveConnection` is required whenever a playbook in the tree has a function step.
 */
export async function automationFingerprint(
  resolve: Resolve,
  root: PlaybookRef,
  resolveConnection?: ResolveConnection,
): Promise<string> {
  const lines = new Set<string>();
  const visit = async (r: PlaybookRef, depth: number) => {
    if (depth > MAX_DEPTH)
      throw new Error(`Child playbooks nest deeper than ${MAX_DEPTH} levels at ${r.ref}.`);
    const resolved = await resolve(r.ref, r.version);
    const line = `${r.ref}@${resolved.version}#${resolved.sha256}`;
    if (lines.has(line)) return;
    lines.add(line);
    for (const key of connectionRefs(resolved.def)) {
      if (!resolveConnection)
        throw new Error(`${r.ref} calls connection ${key}: the fingerprint needs the connection resolver.`);
      const c = await resolveConnection(key);
      lines.add(`connection:${key}@${c.version}#${c.sha256}`);
    }
    for (const child of childRefs(resolved.def)) await visit(child, depth + 1);
  };
  await visit(root, 0);
  return createHash('sha256')
    .update([...lines].sort().join('\n'))
    .digest('hex');
}

/** Whether any playbook in the tree (the root and every child it can start) changes data. */
export async function writesInTree(
  resolve: Resolve,
  root: PlaybookRef,
  writes: (def: Playbook | Runbook) => boolean,
): Promise<boolean> {
  const seen = new Set<string>();
  const visit = async (r: PlaybookRef, depth: number): Promise<boolean> => {
    if (depth > MAX_DEPTH)
      throw new Error(`Child playbooks nest deeper than ${MAX_DEPTH} levels at ${r.ref}.`);
    const resolved = await resolve(r.ref, r.version);
    const id = `${r.ref}@${resolved.version}`;
    if (seen.has(id)) return false;
    seen.add(id);
    if (writes(resolved.def)) return true;
    for (const child of childRefs(resolved.def)) if (await visit(child, depth + 1)) return true;
    return false;
  };
  return visit(root, 0);
}
