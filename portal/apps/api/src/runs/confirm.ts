import { containsRedacted, redact } from '@adminforge/engine';
import { renderTemplate } from '@adminforge/expressions';
import { normalizeConfirmation, withoutBidiControls, type Confirm } from '@adminforge/schemas';

/**
 * A playbook's confirmation as the person sees it (GET /api/runs/:id → `run.confirm` on their own succeeded preview),
 * rendered here from the preview's inputs and stored step outputs — never in the browser (the page runs under
 * `script-src 'self'`, and the API decides what is shown). `value` is exactly what the API compares a typed
 * confirmation with (`checkTyped`).
 */
export interface ConfirmView {
  type: 'click' | 'typed';
  /** typed: the text to type; null when the preview didn't produce it (the run can't be confirmed: preview again). */
  value: string | null;
  /** The author's message, rendered; null when there is none or it couldn't be rendered. */
  message: string | null;
}

/** A rendered template as text, or null: only strings and numbers are text (a masked or missing value is not). */
async function renderText(template: string, scope: Record<string, unknown>): Promise<string | null> {
  let v: unknown;
  try {
    v = await renderTemplate(template, scope);
  } catch {
    return null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * `confirm.value`, rendered: the text a typed confirmation compares with. Null when it can't be rendered, isn't text,
 * has nothing visible to type (an app named with invisible characters only), or carries a masked value (`[redacted]`,
 * or a `redact: true` input) — nobody can be asked to type that.
 */
export async function confirmValue(
  confirm: Confirm,
  scope: Record<string, unknown>,
  secrets: readonly string[],
): Promise<string | null> {
  if (!confirm.value) return null;
  const v = await renderText(confirm.value, scope);
  if (v === null || normalizeConfirmation(v) === '') return null;
  return containsRedacted(v) || redact(v, secrets) !== v ? null : v;
}

/**
 * `confirm.message`, rendered for the person who previewed (the dialog shows it next to the value to type), without
 * bidi controls (tenant names in it can't reorder the sentence). Null when it can't be rendered, or when it would show
 * a `redact: true` input.
 */
export async function confirmMessage(
  confirm: Confirm,
  scope: Record<string, unknown>,
  secrets: readonly string[],
): Promise<string | null> {
  if (!confirm.message) return null;
  const m = await renderText(confirm.message, scope);
  return m === null || redact(m, secrets) !== m ? null : withoutBidiControls(m).trim();
}

/** The confirmation of a preview, rendered (null for `confirm: none` or none at all). */
export async function renderConfirm(
  confirm: Confirm | undefined,
  scope: Record<string, unknown>,
  secrets: readonly string[],
): Promise<ConfirmView | null> {
  if (!confirm || confirm.type === 'none') return null;
  const [value, message] = await Promise.all([
    confirm.type === 'typed' ? confirmValue(confirm, scope, secrets) : Promise.resolve(null),
    confirmMessage(confirm, scope, secrets),
  ]);
  return { type: confirm.type, value, message };
}
