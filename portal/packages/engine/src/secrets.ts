/**
 * Show-once secrets (passwords, Temporary Access Passes, client secrets). A step declares `secretOutputs: [paths]` or
 * `secret: true`; the engine replaces those values by a marker everywhere — the stored step output, run outputs,
 * events, plans, audit, and the expression scope of later steps — and hands the real values to a SecretSink exactly
 * once (the API shows them to the person who started the run over the live event stream, or holds them in memory for
 * one fetch within 5 minutes). Secrets never reach Postgres.
 */

export interface SecretMarker {
  $secret: true;
  /** Last 4 characters of long values, else the length — enough to recognise, not to use. */
  hint: string;
}

export interface SecretSpec {
  /** Segment lists; an empty list means the whole output. `*` matches every key/element. */
  paths: string[][];
}

export const isSecretMarker = (v: unknown): v is SecretMarker => !!v && typeof v === 'object' && (v as { $secret?: unknown }).$secret === true;

/** The secret spec of a step (null when it declares none). */
export function secretSpec(step: { secret?: boolean | undefined; secretOutputs?: string[] | undefined }): SecretSpec | null {
  const paths = [...(step.secret ? [[] as string[]] : []), ...(step.secretOutputs ?? []).map((p) => p.split('.'))];
  return paths.length ? { paths } : null;
}

export function secretHint(value: unknown): string {
  if (typeof value === 'string') return value.length >= 20 ? `…${value.slice(-4)}` : `${value.length} characters`;
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === 'object') return 'object';
  return typeof value;
}

const marker = (value: unknown): SecretMarker => ({ $secret: true, hint: secretHint(value) });

export interface ExtractedSecrets {
  /** The output with every secret replaced by a marker (safe to store and to expose to expressions). */
  masked: unknown;
  /** Concrete path (`$` = whole output) → secret value. */
  values: Record<string, unknown>;
  hints: Record<string, string>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Splits an output into its masked form and the secret values at the declared paths (null/undefined values are not secrets). */
export function extractSecrets(output: unknown, spec: SecretSpec | null): ExtractedSecrets {
  const values: Record<string, unknown> = {};
  const hints: Record<string, string> = {};
  if (!spec || output === undefined || output === null) return { masked: output, values, hints };
  if (spec.paths.some((p) => p.length === 0)) {
    if (isSecretMarker(output)) return { masked: output, values, hints };
    values.$ = output;
    hints.$ = secretHint(output);
    return { masked: marker(output), values, hints };
  }
  const masked = structuredClone(output);
  const walk = (node: unknown, segs: string[], at: string[], set: (v: unknown) => void) => {
    if (node === undefined || node === null) return;
    if (!segs.length) {
      if (isSecretMarker(node)) return;
      const key = at.join('.');
      values[key] = node;
      hints[key] = secretHint(node);
      set(marker(node));
      return;
    }
    const [head, ...rest] = segs as [string, ...string[]];
    if (Array.isArray(node)) {
      const indexes = head === '*' ? node.map((_, i) => i) : /^\d+$/.test(head) ? [Number(head)] : [];
      for (const i of indexes) if (i < node.length) walk(node[i], rest, [...at, String(i)], (v) => (node[i] = v));
    } else if (isPlainObject(node)) {
      const keys = head === '*' ? Object.keys(node) : Object.hasOwn(node, head) ? [head] : [];
      for (const k of keys) walk(node[k], rest, [...at, k], (v) => (node[k] = v));
    }
  };
  for (const p of spec.paths) walk(masked, p, [], () => undefined);
  return { masked, values, hints };
}
