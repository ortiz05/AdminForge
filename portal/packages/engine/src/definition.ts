import { flattenSteps, stepMode, walkSteps, type Step } from '@adminforge/schemas';
import { DEFAULT_LIMITS, type AutomationDefinition, type Limits } from './types';

/** Path of the implicit approval gate added for `approval: { required: true }` definitions. */
export const IMPLICIT_APPROVAL = '$approval';

/** Every step (nested included) in depth-first execution order. */
export function allSteps(def: AutomationDefinition): Step[] {
  const out: Step[] = [];
  walkSteps(flattenSteps(def), (s) => out.push(s));
  return out;
}

export const countSteps = (def: AutomationDefinition): number => allSteps(def).length;

/**
 * Whether a step writes. In a write definition a step that starts a child playbook, or carries a compensation (always a
 * write), counts as one whatever its own mode says: validate requires `mode: write` there, and the approval gate and the
 * armed checks don't rely on it (M1). A read-only definition's children can only read.
 */
const writes = (def: AutomationDefinition, s: Step): boolean =>
  stepMode(s) === 'write' || (def.mode === 'write' && (s.type === 'playbook' || !!s.compensate));

const containsWrite = (def: AutomationDefinition, step: Step): boolean => {
  let found = false;
  walkSteps([step], (s) => {
    if (writes(def, s)) found = true;
  });
  return found;
};

/** True when any step (nested included) writes. */
export const hasWriteSteps = (def: AutomationDefinition): boolean =>
  allSteps(def).some((s) => writes(def, s));

/** Static checks done before a run is created or started. Returns a message, or undefined when the definition can run. */
export function checkDefinition(
  def: AutomationDefinition,
  limits: Limits = DEFAULT_LIMITS,
): string | undefined {
  const n = countSteps(def);
  if (n > limits.maxSteps) return `This ${def.kind} has ${n} steps; the limit is ${limits.maxSteps}.`;
  return undefined;
}

/**
 * Index of the top-level step the implicit approval gate goes before (`approval: { required: true }`): the first
 * top-level step that is or contains a write. -1 when no gate is needed (not required, no writes, or an explicit
 * approval step already precedes the first write).
 */
export function implicitApprovalIndex(def: AutomationDefinition): number {
  if (!def.approval?.required) return -1;
  const top = flattenSteps(def);
  for (let i = 0; i < top.length; i++) {
    const s = top[i]!;
    if (s.type === 'approval') return -1;
    if (containsWrite(def, s)) return i;
  }
  return -1;
}

/** The step id at the end of a path (`loop[2].approve` → `approve`, `$approval` → `$approval`). */
export function stepIdOf(path: string): string {
  const base = path.split('#')[0]!;
  const last = base.split('.').pop()!;
  return last.replace(/\[\d+\]$/, '');
}

/**
 * Whether any write step can run after the approval at `path` (the approver must then be armed, §5.6).
 * Steps inside the same forEach count, since later iterations run after this one.
 */
export function writesAfter(def: AutomationDefinition, path: string): boolean {
  if (path === IMPLICIT_APPROVAL) return hasWriteSteps(def);
  const id = stepIdOf(path);
  const order = allSteps(def);
  const at = order.findIndex((s) => s.id === id);
  if (at < 0) return hasWriteSteps(def);
  if (order.slice(at + 1).some((s) => writes(def, s))) return true;
  // Enclosing forEach bodies repeat.
  let enclosingWrites = false;
  walkSteps(flattenSteps(def), (s) => {
    if (s.type !== 'forEach') return;
    let inside = false;
    walkSteps(s.steps, (x) => {
      if (x.id === id) inside = true;
    });
    if (inside && containsWrite(def, s)) enclosingWrites = true;
  });
  return enclosingWrites;
}

/** Finds a step by id anywhere in the definition. */
export function findStep(def: AutomationDefinition, id: string): Step | undefined {
  return allSteps(def).find((s) => s.id === id);
}
