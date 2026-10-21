import type { Playbook, Runbook } from '@adminforge/schemas';
import type { RunDetail } from '../runs/contracts';

/**
 * What the confirmation shows, from the dry run that was just shown. The API renders the playbook's `confirm.value`
 * and `confirm.message` from the preview's step outputs and returns them with it (`run.confirm`, for the person who
 * previewed); the browser never evaluates a `${ … }` template (the page runs under `script-src 'self'`, and the text
 * to type must be the one the API compares with).
 */

/** The text a typed confirmation asks for, or null when the preview didn't produce it (it can't be confirmed). */
export function confirmationText(preview: RunDetail | null | undefined): string | null {
  const value = preview?.run.confirm?.value;
  return value && value.trim() ? value : null;
}

/** The author's confirmation message as rendered for this preview (null: none, or it couldn't be rendered). */
export function confirmationMessage(preview: RunDetail | null | undefined): string | null {
  const message = preview?.run.confirm?.message;
  return message && message.trim() ? message : null;
}

/**
 * The confirmation message before there is a preview (the risk banner): only when it is plain text. A templated one
 * names what the preview finds, so it is shown in the confirmation once the API has rendered it.
 */
export function staticConfirmMessage(def: Pick<Playbook | Runbook, 'confirm'>): string | null {
  const message = def.confirm?.message;
  return message && !message.includes('${') ? message : null;
}

/** Bulk runs confirm the blast radius: the number of items ("Type 12 to confirm changing 12 objects"). */
export const bulkConfirmationText = (count: number) => String(count);
