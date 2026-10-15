import { createHash } from 'node:crypto';
import { flattenSteps, walkSteps, type Playbook, type Runbook } from '@adminforge/schemas';

export interface PlaybookRef {
  ref: string;
  version?: string;
}

type Resolve = (
  ref: string,
  version?: string,
) => Promise<{ def: Playbook | Runbook; version: string; sha256: string }>;

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

const MAX_DEPTH = 8;

/**
 * What a schedule approval covers: sha256 over `ref@version#sha256` of the playbook and, recursively, every playbook
 * it can start. Publishing a new version of any of them changes the fingerprint, so the approval no longer applies.
 */
export async function automationFingerprint(resolve: Resolve, root: PlaybookRef): Promise<string> {
  const lines = new Set<string>();
  const visit = async (r: PlaybookRef, depth: number) => {
    if (depth > MAX_DEPTH)
      throw new Error(`Child playbooks nest deeper than ${MAX_DEPTH} levels at ${r.ref}.`);
    const resolved = await resolve(r.ref, r.version);
    const line = `${r.ref}@${resolved.version}#${resolved.sha256}`;
    if (lines.has(line)) return;
    lines.add(line);
    for (const child of childRefs(resolved.def)) await visit(child, depth + 1);
  };
  await visit(root, 0);
  return createHash('sha256')
    .update([...lines].sort().join('\n'))
    .digest('hex');
}
