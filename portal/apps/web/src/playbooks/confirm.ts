import type { Playbook } from '@adminforge/schemas';
import type { RunDetail } from '../runs/contracts';

/**
 * The text a typed confirmation asks for. The playbook's `confirm.value` is a template over the run scope
 * (`${ steps.lookup.output.userPrincipalName }`), so it is rendered against the dry run that was just shown:
 * the server's rendered value wins when it sends one; otherwise the template is evaluated here (JSONata loads on
 * demand). Falls back to the playbook key, so a broken template never makes a write unconfirmable.
 */
export async function confirmationText(
  def: Playbook,
  preview: RunDetail | null,
  user: { oid: string; upn: string },
): Promise<string> {
  const template = def.confirm?.value;
  if (preview?.run.confirm?.value) return preview.run.confirm.value;
  if (!template) return def.id;
  if (!template.includes('${')) return template;
  if (!preview) return def.id;
  const steps: Record<string, { output: unknown }> = {};
  for (const s of preview.steps) steps[s.stepId] = { output: s.output };
  try {
    const { renderString } = await import('@adminforge/expressions');
    const value = await renderString(template, {
      inputs: preview.run.inputs,
      steps,
      user,
      run: { id: preview.run.id },
    });
    return typeof value === 'string' && value.trim()
      ? value.trim()
      : value != null && String(value).trim()
        ? String(value)
        : def.id;
  } catch {
    return def.id;
  }
}

/** Bulk runs confirm the blast radius: the number of items ("Type 12 to confirm changing 12 objects"). */
export const bulkConfirmationText = (count: number) => String(count);
