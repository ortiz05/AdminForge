import { renderTemplate } from '@adminforge/expressions';
import { checkInputValue, type Params } from '@adminforge/schemas';

/**
 * Validates run inputs against a playbook/runbook `inputs:` block (§7.7): required unless `required: false` or a
 * default is given; defaults applied (expression defaults see `now` and `env`); values coerced where unambiguous
 * ("42" → 42, "true" → true); unknown keys refused so nothing unexpected reaches expressions. Each value goes through
 * `checkInputValue` from @adminforge/schemas — the same check the run form runs in the browser.
 */

export interface InputIssue {
  field: string;
  message: string;
}

export type InputValidation =
  { ok: true; values: Record<string, unknown> } | { ok: false; errors: InputIssue[] };

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export interface ValidateInputsOptions {
  now?: Date;
  env?: Record<string, unknown>;
  /** Page params are optional unless `required: true`; inputs (default) are required unless `required: false`. */
  kind?: 'inputs' | 'params';
}

export async function validateInputs(
  params: Params | undefined,
  raw: unknown,
  opts: ValidateInputsOptions = {},
): Promise<InputValidation> {
  const now = opts.now ?? new Date();
  const errors: InputIssue[] = [];
  const values: Record<string, unknown> = {};
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
    return { ok: false, errors: [{ field: '', message: 'Inputs must be an object.' }] };
  const given = (raw ?? {}) as Record<string, unknown>;
  const declared = params ?? {};
  for (const key of Object.keys(given))
    if (!Object.hasOwn(declared, key)) errors.push({ field: key, message: 'Unknown input.' });
  for (const [name, p] of Object.entries(declared)) {
    let v = given[name];
    if (isBlank(v) || (Array.isArray(v) && v.length === 0)) {
      v = undefined;
      if (p.default !== undefined) {
        try {
          v =
            typeof p.default === 'string' && p.default.includes('${')
              ? await renderTemplate(p.default, { now: now.toISOString(), env: opts.env ?? {} })
              : p.default;
        } catch (err) {
          errors.push({ field: name, message: `Default could not be evaluated: ${(err as Error).message}` });
          continue;
        }
      }
    }
    if (v === undefined || v === null) {
      const required = opts.kind === 'params' ? p.required === true : p.required !== false;
      if (required) errors.push({ field: name, message: `${p.label ?? name} is required.` });
      continue;
    }
    const r = checkInputValue(p, v, now);
    if ('error' in r) errors.push({ field: name, message: r.error });
    else values[name] = r.value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}
