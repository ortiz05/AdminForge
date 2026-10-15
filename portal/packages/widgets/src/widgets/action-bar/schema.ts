import { z } from 'zod';
import { ActionSpec, blockShape } from '../../lib/schema-common';

/** Buttons that launch playbooks or open links (docs/widgets.md › actionBar). Inputs are templated (scope: page). */
export const ActionBarConfig = z.looseObject({
  widget: z.literal('actionBar'),
  ...blockShape,
  actions: z.array(ActionSpec).min(1).max(12),
});
export type ActionBarConfig = z.infer<typeof ActionBarConfig>;
